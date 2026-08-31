from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

import llvmlite
import numba
import numpy as np

from .probe import (
    ADAPTER_VERSION,
    PROBE_ID,
    PROBE_VERSION,
    PROBE_CONTRACT_SHA256,
    NumbaReferenceError,
    build_reference_trace,
    stable_json_bytes,
)

EXPECTED_PYTHON = "3.12.10"
EXPECTED_NUMBA = "0.67.0"
EXPECTED_LLVMLITE = "0.49.0"
EXPECTED_NUMPY = "2.5.2"
EXPECTED_PYARROW = "25.0.1"
REPORT_SCHEMA_VERSION = "HDH_P6_NUMBA_TRACE_REPORT_V1"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"{label} must be a JSON object")
    return value


def assert_exact_environment() -> dict[str, str]:
    try:
        import pyarrow
    except Exception as exc:
        raise NumbaReferenceError("P6_NUMBA_ENVIRONMENT_MISMATCH", f"pyarrow import failed: {exc}") from exc
    versions = {
        "python": ".".join(map(str, sys.version_info[:3])),
        "numba": numba.__version__,
        "llvmlite": llvmlite.__version__,
        "numpy": np.__version__,
        "pyarrow": pyarrow.__version__,
    }
    expected = {
        "python": EXPECTED_PYTHON,
        "numba": EXPECTED_NUMBA,
        "llvmlite": EXPECTED_LLVMLITE,
        "numpy": EXPECTED_NUMPY,
        "pyarrow": EXPECTED_PYARROW,
    }
    if versions != expected:
        raise NumbaReferenceError(
            "P6_NUMBA_ENVIRONMENT_MISMATCH",
            f"exact reference environment required: expected={expected}, actual={versions}",
        )
    return versions


def _require_equal(dataset: dict[str, Any], run_spec: dict[str, Any], key: str) -> None:
    if dataset.get(key) != run_spec.get(key):
        raise NumbaReferenceError("P6_NUMBA_BINDING_MISMATCH", f"{key} differs between numba dataset binding and parity run spec")


def _parquet_hash_root(files: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for binding in sorted(files, key=lambda item: str(item.get("path", ""))):
        path = binding.get("path")
        physical = binding.get("physical_sha256")
        if not isinstance(path, str) or not isinstance(physical, str):
            raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "parquet_files entries require path and physical_sha256")
        lines.append(f"{path}  {physical}\n")
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


def _ensure_outside_packet(output_dir: Path, packet_root: Path) -> Path:
    output = output_dir.resolve()
    packet = packet_root.resolve()
    if output == packet or packet in output.parents:
        raise NumbaReferenceError("P6_NUMBA_OUTPUT_INSIDE_PACKET", "trace output must be outside the accepted DATA_PACKET tree")
    return output


def _read_accepted_arrays(
    dataset_path: Path,
    dataset: dict[str, Any],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    try:
        import pyarrow.parquet as pq
    except Exception as exc:
        raise NumbaReferenceError("P6_NUMBA_ENVIRONMENT_MISMATCH", f"pyarrow import failed: {exc}") from exc

    files = dataset.get("parquet_files")
    if not isinstance(files, list) or not files:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "numba dataset binding must contain parquet_files")

    packet_root = dataset_path.resolve().parent.parent
    timestamps: list[np.ndarray] = []
    source_seqs: list[np.ndarray] = []
    bids: list[np.ndarray] = []
    asks: list[np.ndarray] = []

    for index, binding in enumerate(files):
        if not isinstance(binding, dict):
            raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"parquet_files[{index}] must be an object")
        rel = binding.get("path")
        expected_sha = binding.get("physical_sha256")
        expected_rows = binding.get("row_count")
        if not isinstance(rel, str) or not rel.startswith("canonical/") or "\\" in rel:
            raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"parquet_files[{index}].path is invalid")
        if not isinstance(expected_sha, str) or len(expected_sha) != 64:
            raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"parquet_files[{index}].physical_sha256 is invalid")
        if not isinstance(expected_rows, int) or expected_rows < 0:
            raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"parquet_files[{index}].row_count is invalid")

        path = (packet_root / Path(*rel.split("/"))).resolve()
        if packet_root.resolve() not in path.parents:
            raise NumbaReferenceError("P6_NUMBA_PATH_ESCAPE", f"parquet_files[{index}] escapes DATA_PACKET")
        if not path.is_file():
            raise NumbaReferenceError("P6_NUMBA_PARQUET_MISSING", f"missing accepted Parquet file: {rel}")
        before_sha = _sha256_file(path)
        if before_sha != expected_sha:
            raise NumbaReferenceError("P6_NUMBA_PARQUET_SHA_MISMATCH", f"Parquet SHA256 mismatch before read: {rel}")

        table = pq.read_table(path, columns=["timestamp_msc", "source_seq", "bid_scaled", "ask_scaled"])
        if table.num_rows != expected_rows:
            raise NumbaReferenceError("P6_NUMBA_PARQUET_ROW_COUNT_MISMATCH", f"Parquet row_count mismatch: {rel}")
        cols = [table[name].combine_chunks().to_numpy(zero_copy_only=False) for name in ("timestamp_msc", "source_seq", "bid_scaled", "ask_scaled")]
        ts, seq, bid, ask = [np.asarray(col, dtype=np.int64) for col in cols]
        if seq.shape[0] != expected_rows or not np.array_equal(seq, np.arange(expected_rows, dtype=np.int64)):
            raise NumbaReferenceError("P6_NUMBA_SOURCE_ORDER_MISMATCH", f"source_seq order mismatch: {rel}")
        after_sha = _sha256_file(path)
        if after_sha != before_sha:
            raise NumbaReferenceError("P6_NUMBA_PARQUET_CHANGED_DURING_READ", f"Parquet bytes changed during read: {rel}")

        timestamps.append(ts)
        source_seqs.append(seq)
        bids.append(bid)
        asks.append(ask)

    return (
        np.concatenate(timestamps),
        np.concatenate(source_seqs),
        np.concatenate(bids),
        np.concatenate(asks),
    )


def run_local_numba_adapter(
    *,
    numba_dataset_path: str | os.PathLike[str],
    parity_run_spec_path: str | os.PathLike[str],
    output_dir: str | os.PathLike[str],
    enforce_environment: bool = True,
) -> dict[str, Any]:
    dataset_path = Path(numba_dataset_path).resolve()
    run_path = Path(parity_run_spec_path).resolve()
    dataset = _load_json(dataset_path, "numba/dataset.json")
    run_spec = _load_json(run_path, "parity_run_spec")

    if dataset.get("schema_version") != "0.1.0" or dataset.get("dataset_binding_status") != "BOUND_P2_5_PACKET":
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "numba dataset binding is not the accepted P2.5 schema")
    if run_spec.get("parity_run_spec_schema_version") != "HDH_P6_PARITY_RUN_SPEC_V1" or run_spec.get("run_spec_status") != "BOUND":
        raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", "parity run spec is not a bound HDH_P6_PARITY_RUN_SPEC_V1")
    parity_run_id = run_spec.get("parity_run_id")
    if not isinstance(parity_run_id, str) or not parity_run_id.startswith("HDH_P6_RUN_V1_") or len(parity_run_id) != 78:
        raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", "parity_run_id is invalid")
    if run_spec.get("numba_adapter_version") != ADAPTER_VERSION:
        raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", f"numba_adapter_version must be {ADAPTER_VERSION}")
    if run_spec.get("logic_contract_id") != PROBE_ID:
        raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", f"logic_contract_id must be {PROBE_ID}")
    if run_spec.get("logic_contract_sha256") != PROBE_CONTRACT_SHA256:
        raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", "logic_contract_sha256 does not match P6_REFERENCE_PARITY_PROBE_V1")

    for key in (
        "dataset_id",
        "source_hash_root",
        "canonical_logical_hash_root",
        "symbol",
        "requested_from_utc",
        "requested_to_utc",
        "price_digits",
        "price_scale",
    ):
        _require_equal(dataset, run_spec, key)

    files = dataset.get("parquet_files")
    if not isinstance(files, list) or not files:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "numba dataset binding must contain parquet_files")
    if _parquet_hash_root(files) != run_spec.get("parquet_file_hash_root"):
        raise NumbaReferenceError("P6_NUMBA_BINDING_MISMATCH", "parquet_file_hash_root does not match numba dataset binding")
    expected_tick_count = sum(int(item["row_count"]) for item in files if isinstance(item, dict) and isinstance(item.get("row_count"), int))
    if expected_tick_count != run_spec.get("tick_count_total"):
        raise NumbaReferenceError("P6_NUMBA_BINDING_MISMATCH", "tick_count_total does not match numba dataset binding")

    versions = assert_exact_environment() if enforce_environment else {
        "python": ".".join(map(str, sys.version_info[:3])),
        "numba": numba.__version__,
        "llvmlite": llvmlite.__version__,
        "numpy": np.__version__,
        "pyarrow": "UNVERIFIED_TEST_OVERRIDE",
    }
    if enforce_environment:
        declared = run_spec.get("environment_versions")
        if not isinstance(declared, dict):
            raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", "parity run spec must bind environment_versions")
        for key, actual in versions.items():
            if declared.get(key) != actual:
                raise NumbaReferenceError("P6_NUMBA_ENVIRONMENT_MISMATCH", f"run spec environment_versions.{key} is not bound to the exact P6.3 environment")

    packet_root = dataset_path.parent.parent
    output = _ensure_outside_packet(Path(output_dir), packet_root)
    trace_path = output / "numba_trace.json"
    report_path = output / "numba_trace_report.json"
    if trace_path.exists() or report_path.exists():
        raise NumbaReferenceError("P6_NUMBA_OUTPUT_EXISTS", "reference adapter does not overwrite existing trace evidence")
    output.mkdir(parents=True, exist_ok=True)

    timestamps, source_seq, bids, asks = _read_accepted_arrays(dataset_path, dataset)
    result = build_reference_trace(
        parity_run_id=parity_run_id,
        timestamp_msc=timestamps,
        source_seq=source_seq,
        bid_scaled=bids,
        ask_scaled=asks,
        price_scale=int(dataset["price_scale"]),
    )

    report = {
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "adapter_version": ADAPTER_VERSION,
        "probe_id": PROBE_ID,
        "probe_version": PROBE_VERSION,
        "parity_run_id": parity_run_id,
        "dataset_id": dataset["dataset_id"],
        "tick_count_total": int(timestamps.shape[0]),
        "trace_event_count": len(result.events),
        "layer_counts": result.layer_counts,
        "trade_count": result.trade_count,
        "total_pnl_scaled": result.total_pnl_scaled,
        "trace_root_sha256": result.trace_root_sha256,
        "environment_versions": versions,
        "input_mutation": False,
        "canonical_reorder": False,
        "source_reacquisition": False,
    }
    trace_path.write_bytes(result.trace_bytes)
    report_path.write_bytes(stable_json_bytes(report))
    return report

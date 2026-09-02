from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from phase6_numba_reference.adapter import (
    ADAPTER_VERSION,
    assert_exact_environment,
    run_local_numba_adapter,
)
from phase6_numba_reference.probe import PROBE_CONTRACT_SHA256, PROBE_ID, NumbaReferenceError, build_reference_trace, stable_json_bytes


RUN_ID = "HDH_P6_RUN_V1_" + ("a" * 64)


def sha_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parquet_root(files: list[dict[str, object]]) -> str:
    text = "".join(
        f"{item['path']}  {item['physical_sha256']}\n"
        for item in sorted(files, key=lambda item: str(item["path"]))
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Phase6NumbaReferenceTests(unittest.TestCase):
    def test_exact_environment(self) -> None:
        versions = assert_exact_environment()
        self.assertEqual(
            versions,
            {
                "python": "3.12.10",
                "numba": "0.67.0",
                "llvmlite": "0.49.0",
                "numpy": "2.5.2",
                "pyarrow": "25.0.1",
            },
        )

    def test_probe_is_deterministic_and_exercises_all_layers(self) -> None:
        n = 2057
        timestamps = np.arange(1_800_000_000_000, 1_800_000_000_000 + n, dtype=np.int64)
        source_seq = np.arange(n, dtype=np.int64)
        bids = np.arange(100_000, 100_000 + n, dtype=np.int64)
        asks = bids + 2
        asks[1024] = bids[1024] + 3

        first = build_reference_trace(
            parity_run_id=RUN_ID,
            timestamp_msc=timestamps,
            source_seq=source_seq,
            bid_scaled=bids,
            ask_scaled=asks,
            price_scale=100_000,
        )
        second = build_reference_trace(
            parity_run_id=RUN_ID,
            timestamp_msc=timestamps,
            source_seq=source_seq,
            bid_scaled=bids,
            ask_scaled=asks,
            price_scale=100_000,
        )
        self.assertEqual(first.trace_bytes, second.trace_bytes)
        self.assertEqual(first.trace_root_sha256, second.trace_root_sha256)
        self.assertEqual(first.trade_count, 3)
        self.assertEqual(first.layer_counts["INPUT"], n)
        self.assertEqual(first.layer_counts["INDICATOR_FEATURE"], n)
        self.assertEqual(first.layer_counts["SIGNAL"], 3)
        self.assertEqual(first.layer_counts["EXECUTION"], 6)
        self.assertEqual(first.layer_counts["RESULT"], 4)
        signal_sides = [event["fields"]["side"] for event in first.events if event["layer"] == "SIGNAL"]
        self.assertEqual(signal_sides, ["LONG", "SHORT", "LONG"])

    def test_probe_rejects_negative_spread(self) -> None:
        with self.assertRaisesRegex(NumbaReferenceError, "negative spread"):
            build_reference_trace(
                parity_run_id=RUN_ID,
                timestamp_msc=[1],
                source_seq=[0],
                bid_scaled=[101],
                ask_scaled=[100],
                price_scale=100,
            )

    def _fixture(self, root: Path, rows: int = 1033) -> tuple[Path, Path, Path]:
        packet = root / "DATA_PACKET"
        canonical_dir = packet / "canonical" / "SYNTH" / "2026" / "08"
        numba_dir = packet / "numba"
        canonical_dir.mkdir(parents=True)
        numba_dir.mkdir(parents=True)

        timestamps = np.arange(1_800_000_000_000, 1_800_000_000_000 + rows, dtype=np.int64)
        seq = np.arange(rows, dtype=np.int32)
        bids_scaled = np.arange(100_000, 100_000 + rows, dtype=np.int64)
        asks_scaled = bids_scaled + 2
        table = pa.table({
            "timestamp_msc": pa.array(timestamps, type=pa.int64()),
            "source_seq": pa.array(seq, type=pa.int32()),
            "bid": pa.array(bids_scaled / 100_000.0, type=pa.float64()),
            "ask": pa.array(asks_scaled / 100_000.0, type=pa.float64()),
            "bid_scaled": pa.array(bids_scaled, type=pa.int64()),
            "ask_scaled": pa.array(asks_scaled, type=pa.int64()),
            "bid_volume": pa.array([None] * rows, type=pa.float64()),
            "ask_volume": pa.array([None] * rows, type=pa.float64()),
        })
        parquet = canonical_dir / "2026-08-31.parquet"
        pq.write_table(table, parquet, compression="snappy")
        rel = "canonical/SYNTH/2026/08/2026-08-31.parquet"
        files = [{
            "date_utc": "2026-08-31",
            "path": rel,
            "physical_sha256": sha_file(parquet),
            "file_size_bytes": parquet.stat().st_size,
            "canonical_logical_row_hash": "b" * 64,
            "row_count": rows,
            "source_snapshot_sha256": "c" * 64,
        }]
        dataset = {
            "schema_version": "0.1.0",
            "dataset_id": "HDH_DATASET_V1_" + ("d" * 64),
            "dataset_binding_status": "BOUND_P2_5_PACKET",
            "canonical_schema_version": "0.1",
            "symbol": "SYNTH",
            "requested_from_utc": "2026-08-31T00:00:00.000Z",
            "requested_to_utc": "2026-09-01T00:00:00.000Z",
            "source_hash_root": "e" * 64,
            "canonical_logical_hash_root": "f" * 64,
            "price_digits": 5,
            "price_scale": 100_000,
            "parquet_files": files,
        }
        dataset_path = numba_dir / "dataset.json"
        dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
        run_spec = {
            "parity_run_spec_schema_version": "HDH_P6_PARITY_RUN_SPEC_V1",
            "run_spec_status": "BOUND",
            "parity_run_id": RUN_ID,
            "dataset_id": dataset["dataset_id"],
            "source_hash_root": dataset["source_hash_root"],
            "canonical_logical_hash_root": dataset["canonical_logical_hash_root"],
            "parquet_file_hash_root": parquet_root(files),
            "mt5_derivative_hash_root": "1" * 64,
            "tick_count_total": rows,
            "symbol": dataset["symbol"],
            "requested_from_utc": dataset["requested_from_utc"],
            "requested_to_utc": dataset["requested_to_utc"],
            "price_digits": dataset["price_digits"],
            "price_scale": dataset["price_scale"],
            "numba_adapter_version": ADAPTER_VERSION,
            "logic_contract_id": PROBE_ID,
            "logic_contract_sha256": PROBE_CONTRACT_SHA256,
            "environment_versions": {
                "python": "3.12.10",
                "numba": "0.67.0",
                "llvmlite": "0.49.0",
                "numpy": "2.5.2",
                "pyarrow": "25.0.1",
            },
        }
        run_path = root / "parity_run_spec.json"
        run_path.write_text(json.dumps(run_spec), encoding="utf-8")
        return dataset_path, run_path, parquet

    def test_adapter_reads_bound_parquet_without_mutation_and_is_repeatable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset_path, run_path, parquet = self._fixture(root)
            before = sha_file(parquet)
            report_a = run_local_numba_adapter(
                numba_dataset_path=dataset_path,
                parity_run_spec_path=run_path,
                output_dir=root / "out-a",
            )
            report_b = run_local_numba_adapter(
                numba_dataset_path=dataset_path,
                parity_run_spec_path=run_path,
                output_dir=root / "out-b",
            )
            self.assertEqual(before, sha_file(parquet))
            self.assertEqual((root / "out-a" / "numba_trace.json").read_bytes(), (root / "out-b" / "numba_trace.json").read_bytes())
            self.assertEqual(report_a["trace_root_sha256"], report_b["trace_root_sha256"])
            self.assertEqual(report_a["layer_counts"], report_b["layer_counts"])
            self.assertFalse(report_a["input_mutation"])
            self.assertFalse(report_a["canonical_reorder"])
            self.assertFalse(report_a["source_reacquisition"])

    def test_adapter_rejects_parquet_tamper_before_read(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset_path, run_path, parquet = self._fixture(root)
            parquet.write_bytes(parquet.read_bytes() + b"x")
            with self.assertRaisesRegex(NumbaReferenceError, "SHA256 mismatch"):
                run_local_numba_adapter(
                    numba_dataset_path=dataset_path,
                    parity_run_spec_path=run_path,
                    output_dir=root / "out",
                )

    def test_adapter_refuses_output_inside_data_packet(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset_path, run_path, _ = self._fixture(root)
            with self.assertRaisesRegex(NumbaReferenceError, "outside the accepted DATA_PACKET"):
                run_local_numba_adapter(
                    numba_dataset_path=dataset_path,
                    parity_run_spec_path=run_path,
                    output_dir=root / "DATA_PACKET" / "evidence",
                )


if __name__ == "__main__":
    unittest.main()

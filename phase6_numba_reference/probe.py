from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

import numpy as np
from numba import njit

TRACE_SCHEMA_VERSION = "HDH_P6_TRACE_EVENT_V1"
PROBE_ID = "P6_REFERENCE_PARITY_PROBE_V1"
PROBE_VERSION = "1.0.0"
ADAPTER_VERSION = "P6_NUMBA_REFERENCE_ADAPTER_V1"
SIGNAL_MODULUS = 1024
EXIT_OFFSET = 8

LAYER_NAMES = ("INPUT", "INDICATOR_FEATURE", "SIGNAL", "EXECUTION", "RESULT")

PROBE_CONTRACT = {
    "logic_contract_schema_version": "HDH_P6_REFERENCE_PROBE_CONTRACT_V1",
    "logic_contract_id": PROBE_ID,
    "probe_version": PROBE_VERSION,
    "input": {
        "order": "NUMBA_DATASET_PARQUET_ARRAY_ORDER_THEN_CANONICAL_ROW_ORDER",
        "required_columns": ["timestamp_msc", "source_seq", "bid_scaled", "ask_scaled"],
        "price_basis": "SCALED_INTEGER_EXACT",
    },
    "feature": {"id": "SPREAD_SCALED_V1", "formula": "ask_scaled-bid_scaled", "numeric": "INT64_EXACT"},
    "signal": {
        "id": "ORDINAL_MOD_1024_SPREAD_PARITY_V1",
        "trigger": "canonical_ordinal%1024==0 AND canonical_ordinal+8<tick_count",
        "direction": "LONG_IF_SPREAD_EVEN_ELSE_SHORT",
    },
    "execution": {
        "entry_ordinal_offset": 1,
        "exit_ordinal_offset": 8,
        "long_entry_side": "ASK",
        "long_exit_side": "BID",
        "short_entry_side": "BID",
        "short_exit_side": "ASK",
    },
    "result": {"pnl": "LONG:exit-entry;SHORT:entry-exit", "numeric": "SCALED_INTEGER_EXACT"},
}


class NumbaReferenceError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status = "HOLD"


@njit(cache=False)
def _feature_and_signal_codes(
    bid_scaled: np.ndarray,
    ask_scaled: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    n = bid_scaled.shape[0]
    spreads = np.empty(n, dtype=np.int64)
    signal_codes = np.zeros(n, dtype=np.int8)
    for i in range(n):
        spread = ask_scaled[i] - bid_scaled[i]
        spreads[i] = spread
        if spread < 0:
            signal_codes[i] = -2
        elif i % SIGNAL_MODULUS == 0 and i + EXIT_OFFSET < n:
            signal_codes[i] = 1 if spread % 2 == 0 else -1
    return spreads, signal_codes


def stable_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


PROBE_CONTRACT_SHA256 = sha256_bytes(stable_json_bytes(PROBE_CONTRACT))


@dataclass(frozen=True)
class ProbeOutput:
    events: list[dict[str, Any]]
    trace_bytes: bytes
    trace_root_sha256: str
    layer_counts: dict[str, int]
    trade_count: int
    total_pnl_scaled: int


def _as_int64(values: np.ndarray | list[int], label: str) -> np.ndarray:
    array = np.asarray(values)
    if array.ndim != 1:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"{label} must be one-dimensional")
    if array.dtype.kind not in ("i", "u"):
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"{label} must contain integers")
    if array.dtype.kind == "u" and array.size and int(array.max()) > np.iinfo(np.int64).max:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", f"{label} exceeds int64")
    return array.astype(np.int64, copy=False)


def _event(
    *,
    parity_run_id: str,
    layer: str,
    event_seq: int,
    canonical_ordinal: int | None,
    timestamp_msc: int | None,
    bar_seq: int | None = None,
    signal_seq: int | None = None,
    intent_seq: int | None = None,
    parity_trade_id: str | None = None,
    fields: dict[str, Any],
) -> dict[str, Any]:
    return {
        "trace_schema_version": TRACE_SCHEMA_VERSION,
        "parity_run_id": parity_run_id,
        "engine": "NUMBA",
        "layer": layer,
        "event_seq": event_seq,
        "canonical_ordinal": canonical_ordinal,
        "timestamp_msc": timestamp_msc,
        "bar_seq": bar_seq,
        "signal_seq": signal_seq,
        "intent_seq": intent_seq,
        "parity_trade_id": parity_trade_id,
        "fields": fields,
    }


def build_reference_trace(
    *,
    parity_run_id: str,
    timestamp_msc: np.ndarray | list[int],
    source_seq: np.ndarray | list[int],
    bid_scaled: np.ndarray | list[int],
    ask_scaled: np.ndarray | list[int],
    price_scale: int,
) -> ProbeOutput:
    if not isinstance(parity_run_id, str) or not parity_run_id.startswith("HDH_P6_RUN_V1_") or len(parity_run_id) != 78:
        raise NumbaReferenceError("P6_NUMBA_RUN_SPEC_INVALID", "parity_run_id is invalid")
    if not isinstance(price_scale, int) or price_scale < 1:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "price_scale must be a positive integer")

    timestamps = _as_int64(timestamp_msc, "timestamp_msc")
    sources = _as_int64(source_seq, "source_seq")
    bids = _as_int64(bid_scaled, "bid_scaled")
    asks = _as_int64(ask_scaled, "ask_scaled")
    n = timestamps.shape[0]
    if n == 0:
        raise NumbaReferenceError("P6_NUMBA_EMPTY_INPUT", "accepted reference stream must not be empty")
    if sources.shape[0] != n or bids.shape[0] != n or asks.shape[0] != n:
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "input arrays must have identical lengths")
    if np.any(timestamps < 0) or np.any(sources < 0):
        raise NumbaReferenceError("P6_NUMBA_INPUT_INVALID", "timestamp_msc/source_seq cannot be negative")

    spreads, signal_codes = _feature_and_signal_codes(bids, asks)
    if np.any(spreads < 0):
        raise NumbaReferenceError("P6_NUMBA_NEGATIVE_SPREAD", "negative spread is not valid for the reference probe")

    signal_at: dict[int, tuple[int, str, str]] = {}
    entry_at: dict[int, tuple[int, int, str, str, int]] = {}
    exit_at: dict[int, tuple[int, int, str, str, int, int]] = {}

    trade_index = 0
    for ordinal in range(n):
        code = int(signal_codes[ordinal])
        if code == 0:
            continue
        if code == -2:
            raise NumbaReferenceError("P6_NUMBA_NEGATIVE_SPREAD", "negative spread is not valid for the reference probe")
        side = "LONG" if code == 1 else "SHORT"
        trade_id = f"P6_REF_TRADE_{trade_index:08d}"
        signal_at[ordinal] = (trade_index, side, trade_id)
        entry_ordinal = ordinal + 1
        exit_ordinal = ordinal + EXIT_OFFSET
        entry_price = int(asks[entry_ordinal]) if side == "LONG" else int(bids[entry_ordinal])
        exit_price = int(bids[exit_ordinal]) if side == "LONG" else int(asks[exit_ordinal])
        entry_at[entry_ordinal] = (trade_index, ordinal, side, trade_id, entry_price)
        exit_at[exit_ordinal] = (trade_index, ordinal, side, trade_id, entry_price, exit_price)
        trade_index += 1

    layer_seq = {layer: 0 for layer in LAYER_NAMES}
    events: list[dict[str, Any]] = []
    total_pnl = 0

    for ordinal in range(n):
        ts = int(timestamps[ordinal])
        events.append(_event(
            parity_run_id=parity_run_id,
            layer="INPUT",
            event_seq=layer_seq["INPUT"],
            canonical_ordinal=ordinal,
            timestamp_msc=ts,
            fields={
                "source_seq": int(sources[ordinal]),
                "bid_scaled": int(bids[ordinal]),
                "ask_scaled": int(asks[ordinal]),
                "price_scale": price_scale,
            },
        ))
        layer_seq["INPUT"] += 1

        events.append(_event(
            parity_run_id=parity_run_id,
            layer="INDICATOR_FEATURE",
            event_seq=layer_seq["INDICATOR_FEATURE"],
            canonical_ordinal=ordinal,
            timestamp_msc=ts,
            fields={
                "feature_id": "SPREAD_SCALED_V1",
                "spread_scaled": int(spreads[ordinal]),
            },
        ))
        layer_seq["INDICATOR_FEATURE"] += 1

        signal = signal_at.get(ordinal)
        if signal is not None:
            idx, side, trade_id = signal
            events.append(_event(
                parity_run_id=parity_run_id,
                layer="SIGNAL",
                event_seq=layer_seq["SIGNAL"],
                canonical_ordinal=ordinal,
                timestamp_msc=ts,
                signal_seq=idx,
                parity_trade_id=trade_id,
                fields={
                    "signal_rule": "ORDINAL_MOD_1024_SPREAD_PARITY_V1",
                    "eligible": True,
                    "side": side,
                    "spread_scaled": int(spreads[ordinal]),
                    "entry_offset": 1,
                    "exit_offset": EXIT_OFFSET,
                },
            ))
            layer_seq["SIGNAL"] += 1

        entry = entry_at.get(ordinal)
        if entry is not None:
            idx, signal_ordinal, side, trade_id, entry_price = entry
            events.append(_event(
                parity_run_id=parity_run_id,
                layer="EXECUTION",
                event_seq=layer_seq["EXECUTION"],
                canonical_ordinal=ordinal,
                timestamp_msc=ts,
                signal_seq=idx,
                intent_seq=2 * idx,
                parity_trade_id=trade_id,
                fields={
                    "action": "ENTRY",
                    "side": side,
                    "signal_ordinal": signal_ordinal,
                    "price_scaled": entry_price,
                    "price_side": "ASK" if side == "LONG" else "BID",
                    "execution_model": "REFERENCE_MARKET_NEXT_TICK",
                },
            ))
            layer_seq["EXECUTION"] += 1

        exit_event = exit_at.get(ordinal)
        if exit_event is not None:
            idx, signal_ordinal, side, trade_id, entry_price, exit_price = exit_event
            events.append(_event(
                parity_run_id=parity_run_id,
                layer="EXECUTION",
                event_seq=layer_seq["EXECUTION"],
                canonical_ordinal=ordinal,
                timestamp_msc=ts,
                signal_seq=idx,
                intent_seq=2 * idx + 1,
                parity_trade_id=trade_id,
                fields={
                    "action": "EXIT",
                    "side": side,
                    "signal_ordinal": signal_ordinal,
                    "price_scaled": exit_price,
                    "price_side": "BID" if side == "LONG" else "ASK",
                    "execution_model": "REFERENCE_MARKET_FIXED_EXIT",
                },
            ))
            layer_seq["EXECUTION"] += 1
            pnl = exit_price - entry_price if side == "LONG" else entry_price - exit_price
            total_pnl += pnl
            events.append(_event(
                parity_run_id=parity_run_id,
                layer="RESULT",
                event_seq=layer_seq["RESULT"],
                canonical_ordinal=ordinal,
                timestamp_msc=ts,
                signal_seq=idx,
                parity_trade_id=trade_id,
                fields={
                    "result_type": "TRADE",
                    "side": side,
                    "entry_price_scaled": entry_price,
                    "exit_price_scaled": exit_price,
                    "pnl_scaled": pnl,
                },
            ))
            layer_seq["RESULT"] += 1

    events.append(_event(
        parity_run_id=parity_run_id,
        layer="RESULT",
        event_seq=layer_seq["RESULT"],
        canonical_ordinal=n - 1,
        timestamp_msc=int(timestamps[-1]),
        fields={
            "result_type": "AGGREGATE",
            "trade_count": trade_index,
            "total_pnl_scaled": total_pnl,
        },
    ))
    layer_seq["RESULT"] += 1

    trace_bytes = stable_json_bytes(events)
    return ProbeOutput(
        events=events,
        trace_bytes=trace_bytes,
        trace_root_sha256=sha256_bytes(trace_bytes),
        layer_counts=layer_seq,
        trade_count=trade_index,
        total_pnl_scaled=total_pnl,
    )

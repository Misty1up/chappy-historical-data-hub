# Phase 6 MT5 Reference Adapter

`P6_MT5_REFERENCE_ADAPTER_V1` implements the MT5 side of the public,
non-proprietary `P6_REFERENCE_PARITY_PROBE_V1` frozen for Phase 6.

## Scope

`mt5/HDH_Phase6_Reference_Probe.mq5` is a Strategy Tester trace adapter. It:

- runs only when `MQL_TESTER` is active;
- requires an already prepared isolated Custom Symbol;
- consumes the tick stream delivered to `OnTick` without sorting, deduplication,
  gap filling, Source reacquisition or Canonical mutation;
- reproduces the same scaled-integer spread, signal, logical entry/exit and
  result rules as the accepted Numba reference adapter;
- writes a local JSONL trace and compact local report under `FILE_COMMON`;
- performs no order placement and no real-account execution.

It deliberately contains no Custom Symbol creation/update/import API. Custom
Symbol preparation remains an explicit operator-controlled prerequisite under
the accepted Phase 2 derivative/import authority.

## Frozen probe binding

- logic contract: `P6_REFERENCE_PARITY_PROBE_V1`
- probe version: `1.0.0`
- logic contract SHA-256:
  `cb8fc63ce168100cede8e8475ef6f67dedde19fd1bc02ff51ff5b50b91d0a23b`
- adapter version: `P6_MT5_REFERENCE_ADAPTER_V1`
- feature: exact `spread_scaled = ask_scaled - bid_scaled`
- signal: ordinal modulo 1024, LONG on even spread and SHORT on odd spread
- entry: signal ordinal + 1, LONG Ask / SHORT Bid
- exit: signal ordinal + 8, LONG Bid / SHORT Ask
- result: exact scaled-integer PnL

The adapter validates that the bound `mt5_adapter_version` and
`logic_contract_sha256` inputs match these frozen constants before testing.

## Source sequence bridge

`MqlTick` does not carry Canonical `source_seq`. The accepted Phase 2 derivative
is partitioned by UTC day and preserves every Canonical row in original order,
with `source_seq` zero-based inside each UTC day. The MT5 adapter therefore emits:

`ZERO_BASED_PER_UTC_DAY_FROM_ACCEPTED_MT5_ROW_ORDER`

This is a trace-only reversible bridge, not new data authority. P6.6 must prove
that the isolated Custom Symbol readback and Strategy Tester stream preserve the
accepted derivative tick count, timestamp/Bid/Ask order and same-timestamp
multiplicity. Any missing/reordered tester event remains an Input divergence.

## Local output

Inputs bind the Phase 6 run/dataset/hash identity, expected tick count and
first/last timestamp, accepted precision and a safe output stem.

The adapter refuses to overwrite existing evidence. It writes:

- `<stem>.mt5_trace.jsonl` — one `HDH_P6_TRACE_EVENT_V1` JSON object per line;
- `<stem>.mt5_trace_report.json` — compact `HDH_P6_MT5_TRACE_REPORT_V1` report.

`src/parity/mt5-reference-trace.ts` ingests the JSONL, validates it with the
existing P6.2 MT5 trace contract and computes the normalized trace root. The
MQL5 report records `trace_root_status=COMPUTE_AFTER_INGEST`; it does not define
a second hashing algorithm.

## Acceptance boundary

GitHub CI covers generic schemas, JSONL ingestion, deterministic synthetic trace
identity and static proof that the adapter contains no terminal-mutation/trade
API. It does not install MetaTrader or claim a local MT5 PASS.

P6.4 formal acceptance additionally requires bounded Windows-local evidence:

1. compile `HDH_Phase6_Reference_Probe.mq5` in MetaEditor;
2. run it in Strategy Tester against an isolated synthetic/custom-symbol setup;
3. return only compact compiler/tester/report evidence;
4. do not return market rows or a full real trace to GitHub/Drive;
5. do not mutate GitHub from the local task.

Real accepted R25 Numba↔MT5 parity remains P6.6.

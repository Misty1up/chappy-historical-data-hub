# Phase 6 Numba Reference Adapter

`P6_NUMBA_REFERENCE_ADAPTER_V1` implements the public, non-proprietary
`P6_REFERENCE_PARITY_PROBE_V1` required by the frozen Phase 6 specification.

## Exact environment

- CPython 3.12.10
- numba 0.67.0
- llvmlite 0.49.0
- numpy 2.5.2
- pyarrow 25.0.1

Install only from the exact pins in `phase6_numba_reference/requirements.txt`.

## Input authority

The adapter consumes an already accepted local `DATA_PACKET/numba/dataset.json`,
the Packet-relative Canonical Parquet files referenced by that binding, and a
bound `HDH_P6_PARITY_RUN_SPEC_V1`. It verifies identity fields, the deterministic
Parquet hash root, each Parquet physical SHA-256, row count, and per-file
`source_seq` order before emitting a trace.

The adapter does not acquire Source data, normalize prices, sort, deduplicate,
gap-fill, infer precision, rewrite Canonical data, or map source Bid/Ask volume
into a synthetic MT5 volume.

## Reference probe

For every accepted row:

- `INPUT` copies canonical ordinal, timestamp, source sequence, scaled Bid/Ask and
  price scale.
- `INDICATOR_FEATURE` computes exact integer `spread_scaled = ask_scaled - bid_scaled`
  inside a Numba `njit` core.
- At ordinal `N % 1024 == 0` with `N + 8` available, `SIGNAL` is LONG for an even
  spread and SHORT for an odd spread.
- Entry is at `N+1`: Ask for LONG, Bid for SHORT.
- Exit is at `N+8`: Bid for LONG, Ask for SHORT.
- `RESULT` uses exact scaled-integer PnL and emits a final aggregate result.

There is no claim of trading edge. This probe exists only to exercise the frozen
Input / Indicator-Feature / Signal / Execution / Result parity layers.

## Local command

```text
python -m phase6_numba_reference.cli --numba-dataset <DATA_PACKET/numba/dataset.json> --parity-run-spec <parity_run_spec.json> --output-dir <outside-DATA_PACKET-directory>
```

Full traces remain local. The adapter refuses to write inside the accepted
`DATA_PACKET` tree and refuses to overwrite existing trace evidence.

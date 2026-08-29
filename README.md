# CHAPPY Historical Data Hub

Canonical Dukascopy historical tick data hub for reproducible Numba/MT5 parity research.

## Current phase

**Phase 2 — P2.5 Dataset Packet / Manifest / Hash Audit**

Phase 1 Acquisition Core and P2.1–P2.4 are formally accepted. P2.5 is the only active implementation scope. Phase 3 Web MVP, MCP, AI Router and Portfolio Meta-Controller remain blocked until P2.5 acceptance and formal Phase 2 closeout.

## Core invariants

- UTC calendar-day acquisition and partitioning.
- Bid and Ask remain separate.
- Canonical Bid/Ask volumes remain separate; missing volume remains `null`.
- Original source order is preserved by `source_seq`.
- Same-timestamp and exact duplicate ticks are preserved.
- No silent sorting, dedupe, gap fill or price rounding.
- `bid_scaled` / `ask_scaled` are strict parity fields.
- Canonical Parquet uses exact-pinned `hyparquet-writer@0.16.8` and independent `hyparquet@1.29.2` readback under `HDH_CANONICAL_SNAPPY_V1`.
- MT5 artifacts are derivatives of Canonical rows only; they are never a second research master.
- Downstream reproducibility authority is frozen accepted Source Snapshot bytes + exact SHA + PASS provenance. Live reacquisition is Source Drift Audit only and cannot silently rebaseline an accepted packet.

## Installation and static gate

Node.js 18+ is required.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

CI runs the same locked gate on Node 18, 20, 22 and 24.

## Main CLIs

Acquire Source Tick data:

```bash
npm run hdh -- acquire --symbol EURUSD --from 2026-01-05 --to 2026-01-06 --out ./runs/eurusd-source
```

Precision evidence:

```bash
npm run precision -- --symbol EURUSD --date 2026-01-05 --source-run ./runs/eurusd-source --out ./runs/eurusd-precision
```

Canonical logical evidence:

```bash
npm run canonical -- --symbol EURUSD --date 2026-01-05 --source-run ./runs/eurusd-source --out ./runs/eurusd-canonical
```

Production Canonical Parquet:

```bash
npm run parquet -- --symbol EURUSD --date 2026-01-05 --source-run ./runs/eurusd-source --out ./runs/eurusd-parquet
```

P2.4 MT5 derivative:

```bash
npm run mt5 -- --symbol EURUSD --date 2026-01-05 --source-run ./runs/eurusd-source --out ./runs/eurusd-mt5
```

P2.5 Dataset Packet:

```bash
npm run packet -- \
  --symbol EURUSD \
  --source-run ./runs/accepted-eurusd-source \
  --precision-evidence ./runs/accepted-eurusd-precision/precision_evidence.json \
  --canonical-root ./runs/accepted-eurusd-parquet \
  --mt5-root ./runs/accepted-eurusd-mt5 \
  --out ./runs/accepted-eurusd-data-packet
```

See `docs/MT5_DERIVATIVE.md` for the fixed P2.4 derivative mapping and `docs/DATASET_PACKET.md` for the P2.5 identity, hash-root and binding contract.

## Data location rule

Large market datasets, Source Snapshots, generated Parquet, MT5 derivative files, caches, run artifacts, credentials, broker information, EA/MQL5 strategy logic and IB research logic must never be committed to this public repository. The local PC remains authoritative for actual market-data payloads.

## Not unlocked yet

Phase 3 Web MVP, MCP, Regime detection, AI Router and Portfolio Meta-Controller remain blocked until P2.5 is formally accepted and Phase 2 is closed.

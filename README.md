# CHAPPY Historical Data Hub

Canonical Dukascopy historical tick data hub for reproducible Numba/MT5 parity research.

## Current phase

**Phase 1 — Acquisition Core (implementation under review)**

The current branch is intentionally CLI-first. It acquires Dukascopy tick data into auditable daily Source Tick snapshots without dedupe, gap fill, price rounding, MT5 conversion, or strategy logic.

## Core contract

- UTC calendar-day acquisition units.
- Preserve Bid and Ask separately.
- Preserve Bid/Ask volume; missing volume remains `null`.
- Preserve original source order with `source_seq`.
- Same-timestamp and exact duplicate ticks are audited, not deleted.
- Daily snapshots are deterministic `.jsonl.gz` with SHA-256 evidence.
- Resume is allowed only when the previous PASS snapshot still matches its recorded SHA-256.
- `precision_status=UNVERIFIED` permits acquisition/audit only. It does **not** permit Canonical or MT5 promotion.

## Installation

Node.js 18+ is required. `dukascopy-node` is pinned to exactly `1.50.0`.

```bash
npm install
npm run typecheck
npm test
npm run build
```

`package-lock.json` is required before Phase 1 can be accepted and will be generated/verified in the local execution gate.

## Acquire

```bash
npm run build
npm run hdh -- acquire \
  --symbol XAUUSD \
  --from 2026-01-01 \
  --to 2026-01-08 \
  --out ./runs/xauusd-smoke
```

`--from` is inclusive UTC 00:00; `--to` is exclusive UTC 00:00. `--out` must be relative so local personal paths are not written into evidence.

Optional acquisition controls:

```text
--batch-size <integer>       default 10
--batch-pause-ms <integer>   default 1000
--max-attempts <integer>     default 3
--force                      reacquire instead of hash-verified resume
```

## Verify a run

```bash
npm run hdh -- status --run ./runs/xauusd-smoke
npm run hdh -- verify --run ./runs/xauusd-smoke
npm run hdh -- rehash --run ./runs/xauusd-smoke
```

## Run output

```text
<out>/
├─ job_config.json
├─ source_adapter.json
├─ symbol_registry_snapshot.json
├─ source_ticks/
│  └─ dukascopy-node/<SYMBOL>/YYYY/MM/YYYY-MM-DD.jsonl.gz
├─ integrity/
│  ├─ daily_audit.jsonl
│  └─ gap_and_failure_report.csv
├─ run.log
├─ repro_command.txt
├─ SHA256SUMS.txt
└─ manifest.json
```

## Not in Phase 1

The following are deliberately deferred: Canonical Parquet, MT5 Custom Symbol CSV, GitHub Pages UI, long-run GitHub Actions acquisition, MCP, Regime detection, AI Router, and portfolio control.

Large market datasets, caches, run artifacts, credentials, broker information, EA/MQL5 logic, and IB research logic must never be committed to this public repository.

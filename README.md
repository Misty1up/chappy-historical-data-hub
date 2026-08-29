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
- Project-side retry defaults to four attempts with exponential backoff and bounded jitter; the upstream library retry is disabled.
- `precision_status=UNVERIFIED` permits acquisition/audit only. It does **not** permit Canonical or MT5 promotion.
- Phase 1 manifests always keep `canonical_promotion_allowed=false`; promotion belongs to the later Canonical Packet Builder.

## Installation

Node.js 18+ is required. `dukascopy-node` is pinned to exactly `1.50.0` and the verified dependency graph is committed in `package-lock.json`.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Acquire

```bash
npm run build
npm run hdh -- acquire \
  --symbol XAUUSD \
  --from 2026-01-01 \
  --to 2026-01-08 \
  --out ./runs/xauusd-smoke
```

`--from` is inclusive UTC 00:00; `--to` is exclusive UTC 00:00. `--out` must resolve inside the current working directory so local personal paths are not written into evidence.

Optional acquisition controls:

```text
--batch-size <integer>       default 10
--batch-pause-ms <integer>   default 1000
--max-attempts <integer>     default 4
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

The manifest records runtime, OS, batch/retry settings, PASS/WARN/EMPTY/FAIL counts, source file count, first/last tick, daily source hashes, a deterministic source hash root, and overall integrity status.

## CI

Pull requests and pushes to `main` run the locked static gate on Node.js 18, 20, 22 and 24:

```text
npm ci -> typecheck -> unit tests -> build
```

External Dukascopy network smoke is kept out of automatic CI; accepted local Evidence remains the source for network acquisition verification.

## Not in Phase 1

The following are deliberately deferred: Canonical Parquet, MT5 Custom Symbol CSV, GitHub Pages UI, long-run GitHub Actions acquisition, MCP, Regime detection, AI Router, and portfolio control.

Large market datasets, caches, run artifacts, credentials, broker information, EA/MQL5 logic, and IB research logic must never be committed to this public repository.

# Development

## Requirements

- Node.js 18 or newer.
- `npm ci` from the committed lockfile.
- No dependency on unpublished or `latest`-floating runtime packages.

## Static gate

Before any local network or data validation:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

GitHub CI runs the same static gate on Node 18, 20, 22 and 24.

## Phase 1 acquisition

Use the `hdh` CLI to create Source Tick Snapshot evidence. Source data lives under the selected run directory and must never be committed.

Example:

```bash
npm run hdh -- acquire --symbol EURUSD --from 2026-01-05 --to 2026-01-06 --out ./runs/eurusd-source
npm run hdh -- verify --run ./runs/eurusd-source
```

`--from` is inclusive UTC 00:00 and `--to` is exclusive UTC 00:00. Run paths must remain inside the current working directory.

The project-side retry policy defaults to four total attempts with exponential backoff and bounded jitter. `dukascopy-node` internal retry remains disabled so retry behavior is owned and evidenced by this project.

## Phase 2 precision

Precision verification probes the actual Dukascopy multiplier and checks the complete Source Snapshot price lattice. It does not edit the registry automatically.

```bash
npm run precision -- --symbol EURUSD --date 2026-01-05 --source-run ./runs/eurusd-source --out ./runs/eurusd-precision
```

R08 formally accepted:

- EURUSD: `price_digits=5`, `price_scale=100000`.
- XAUUSD: `price_digits=3`, `price_scale=1000`.

## Phase 2 Canonical core gate

The Canonical core converts a PASS Source Tick Snapshot to strict in-memory Canonical rows and writes evidence only. It does not yet create Parquet.

```bash
npm run canonical -- --symbol EURUSD --date 2026-01-05 --source-run ./runs/eurusd-source --out ./runs/eurusd-canonical
```

The output directory contains:

- `canonical_evidence.json`
- `canonical.log`
- `repro_command.txt`

A local Canonical core PASS requires:

- the source snapshot SHA matches the Phase 1 audit;
- `source_row_count == canonical_row_count`;
- source order remains `source_seq=0..N-1`;
- exact decimal conversion produces int64 `bid_scaled` / `ask_scaled` with no tolerance;
- no dedupe or gap fill;
- repeated conversion of identical Source Snapshot bytes yields the same `logical_row_sha256`.

R09 is the first real-data gate for this Canonical core. Its repository target SHA is frozen by the associated Exchange packet, not by this document.

## Parquet writer compatibility spike

Do not install a Parquet writer into this repository until the separate compatibility gate is accepted. Candidate writers must be tested in an isolated temporary directory outside the repository with exact version pins.

The compatibility gate must prove at least:

- signed INT64 / BigInt round-trip;
- nullable DOUBLE round-trip;
- row-order preservation including duplicate rows and same timestamps;
- schema and row-count readback using the paired independent reader path;
- repeat-write physical SHA behavior under fixed options;
- no repository/package-lock mutation during the spike.

Only after the spike is formally accepted may a writer dependency be added and the physical Parquet writer be implemented.

## Governance

Implement changes on a dedicated branch and merge only after reviewing the diff and test evidence. Large market data, caches, logs, run artifacts, secrets, broker information and personal paths must never be committed.

Current Phase 2 remains blocked from MT5 derivative, Web UI, MCP and AI Router work until the Canonical Packet gate is complete.

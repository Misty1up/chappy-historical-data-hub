# Development

## Phase 1 commands

With the verified lockfile committed:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Example acquisition after build:

```bash
npm run hdh -- acquire --symbol XAUUSD --from 2026-01-01 --to 2026-01-08 --out ./runs/xauusd-smoke
```

`--from` is inclusive UTC 00:00 and `--to` is exclusive UTC 00:00. Run paths must remain inside the current working directory.

The project-side retry policy defaults to four total attempts with exponential backoff and bounded jitter. `dukascopy-node` internal retry remains disabled so retry behavior is owned and evidenced by this project.

## Validation layers

1. GitHub CI: Node 18/20/22/24, `npm ci`, typecheck, unit tests, build.
2. Local network smoke: EURUSD 1d, XAUUSD 1d, XAUUSD 7d, SHA verify, resume, negative tests.
3. Phase 1 closeout audit: verify manifest/evidence fields and compare selected short windows with the independent Secondary Audit Adapter.

External network smoke is not executed automatically in GitHub Actions.

## Governance

Implement changes on a dedicated branch and merge only after reviewing the diff and test evidence. Large market data, caches, logs, run artifacts, secrets, broker information and personal paths must never be committed.

Phase 1 stops at acquisition-core validation. Do not add Web UI, MT5 export, Parquet builder, MCP, or AI Router in this phase.

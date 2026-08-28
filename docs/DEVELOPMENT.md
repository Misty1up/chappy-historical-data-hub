# Development

## Phase 1 commands

After dependencies are installed and `package-lock.json` exists:

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

`--from` is inclusive UTC 00:00 and `--to` is exclusive UTC 00:00.

## Governance

Implement changes on a dedicated branch and merge only after reviewing the diff and test evidence. Large market data, caches, logs, run artifacts, secrets, broker information and personal paths must never be committed.

Phase 1 stops at acquisition-core validation. Do not add Web UI, MT5 export, Parquet builder, MCP, or AI Router in this phase.

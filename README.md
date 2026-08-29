# CHAPPY Historical Data Hub

Canonical Dukascopy historical tick data hub for reproducible Numba/MT5 parity research.

## Current phase

Phase 3 Web MVP is developed as a thin control plane over the accepted Phase 1–2 CLI and Dataset Packet contracts. The Web layer must not redefine dataset identity, source authority, precision, Canonical semantics, ordering, Bid/Ask, or hash-chain contracts.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run build:web
```

`npm run build:web` produces a GitHub Pages-compatible static bundle in `dist-web/`. It copies the accepted symbol registry and the compiled Web request contract into the static output; it does not perform market-data acquisition or Canonical transformation.

## Phase 3 Web MVP

The current Web MVP supports:

- accepted Symbol selection
- strict UTC period input
- Mode selection (`QUICK_DOWNLOAD`, `RESEARCH_MASTER`, `MT5_PARITY_MASTER`)
- request validation
- exact review payload generation
- explicit authority notice that Web requests are not Dataset identity authority

The Web request intentionally excludes `dataset_id`, `source_hash_root`, and `canonical_logical_hash_root`. Those values only come from accepted execution results / manifests.

## Data authority

Accepted Frozen Source Snapshot bytes and their audit provenance remain downstream authority. Live reacquisition must not silently rebaseline accepted inputs. Numba and MT5 derivatives remain bound to the same Canonical rows.

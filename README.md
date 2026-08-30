# CHAPPY Historical Data Hub

Canonical Dukascopy historical tick data hub for reproducible Numba/MT5 parity research.

## Web MVP (Phase 3)

The Phase 3 Web MVP is a thin control plane over the accepted Phase 1–2 contracts. It validates job requests and renders synthetic execution fixtures without redefining dataset identity, source hashes, Canonical logical hashes, precision, row order, or Bid/Ask semantics.

Build the static GitHub Pages-compatible output with:

```bash
npm run build:web
```

The output is written to `dist-web/`.

Phase 3 fixture PASS/HOLD/FAIL states are UI test data only. Fixture metadata is explicitly marked synthetic and `canonical_promotion_allowed` remains false.

# Architecture

CHAPPY Historical Data Hub is a common-data infrastructure layer, not an EA strategy repository.

## Phase 1 pipeline

`Dukascopy -> AcquisitionAdapter -> SourceTick[] -> integrity audit -> deterministic daily JSONL.GZ snapshot -> run evidence`

The first implementation is CLI-first. Web UI, MT5 export, Parquet generation, MCP, and AI routing are explicitly deferred.

## Source-of-truth boundaries

- GitHub: source code, schemas, tests, CI, Pages, releases.
- Google Drive: OS, decisions, handoff, audit/evidence records.
- Local PC: large canonical datasets and research data.

## Non-negotiable rules

- UTC calendar-day acquisition units.
- Preserve Bid and Ask separately.
- Preserve both volumes when provided; `null` stays `null`.
- No gap fill, dedupe, averaging, or price rounding in the acquisition adapter.
- Same-timestamp multiple ticks are valid input and must not be collapsed.
- Generic instrument-history start dates must not be treated as verified tick start dates.
- `precision_status=UNVERIFIED` permits Source Tick acquisition/audit only; it does not permit Canonical/MT5 promotion.

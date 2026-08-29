# Historical Data Hub Data Contract

## Phase 1 Source boundary

The Phase 1 persisted **Source Tick Snapshot** is the immutable research-input representation produced after `dukascopy-node@1.50.0` deterministically decodes the Dukascopy feed response. It is not a claim that provider transport bytes such as BI5/JSON response bodies are persisted byte-for-byte.

Acquisition provenance is therefore mandatory. `source_adapter.json` records the exact library version and decode/normalization settings used to produce the Source Tick Snapshot.

The adapter is fixed to UTC offset 0, tick feed, volumes enabled, volume units expressed as individual units, cache disabled, and upstream library retry disabled. Price reconstruction is performed by the pinned upstream JSON-API multiplier decoder; no additional price rounding is performed by this project after the decoded tick is returned.

## SourceTick

The acquisition layer emits, in original source order:

- `timestamp_msc`: integer milliseconds since Unix epoch, held as `bigint` in memory and decimal string in JSONL.
- `bid`: finite number.
- `ask`: finite number.
- `bid_volume`: finite number or `null`.
- `ask_volume`: finite number or `null`.
- `source_seq`: zero-based source-order sequence within the acquired day.

No row is removed because it is an exact duplicate or shares a timestamp with another row.

## Daily source snapshot

Path:

`source_ticks/dukascopy-node/<symbol>/YYYY/MM/YYYY-MM-DD.jsonl.gz`

Each JSONL record is serialized from SourceTick without project-side price rounding. Snapshot gzip generation is deterministic so repeated serialization of identical SourceTick content yields identical bytes and SHA-256.

## Phase 1 audit

A daily audit records tick count, timestamp bounds, duplicate/same-timestamp counts, out-of-order count, invalid-price count, negative-spread count, snapshot SHA-256 and status.

`PASS` means the Source Tick snapshot passed Phase 1 acquisition integrity checks. It does not mean the data is approved as Canonical or MT5-ready.

## Phase 2 precision guard

`price_digits` and `price_scale` are never guessed. A symbol with `precision_status != VERIFIED` cannot be promoted to Canonical Parquet or an MT5 derivative.

The pinned `dukascopy-node@1.50.0` decoder derives its output price formatting from the upstream JSON response `multiplier`. Phase 2 therefore performs a separate precision probe against the same public Dukascopy JSON API and stores only multiplier-related metadata and response hashes; raw transport bodies are discarded.

The precision gate requires all of the following for a PASS Source Tick day:

1. exactly one normalized multiplier across non-empty hourly responses;
2. the summed upstream hourly tick-delta count equals the Source Snapshot tick count;
3. the Source Snapshot SHA-256 still equals its Phase 1 daily audit;
4. source order remains exactly `source_seq=0..N-1`;
5. the decoder-derived decimal scale converts every lexical Bid and Ask value to an integer exactly, with no tolerance or rounding;
6. accepted independent cross-adapter findings contain no blocking difference.

The probe does **not** automatically edit `symbol_registry.json`. Human/ChatGPT review of local Evidence is required before `precision_status`, `price_digits`, or `price_scale` are promoted.

## Canonical Tick target schema v0.1

Once precision is VERIFIED, the target logical row is:

- `timestamp_msc`: int64 UTC epoch milliseconds;
- `source_seq`: source-order integer;
- `bid`: float64;
- `ask`: float64;
- `bid_scaled`: int64 strict decimal representation;
- `ask_scaled`: int64 strict decimal representation;
- `bid_volume`: nullable float64;
- `ask_volume`: nullable float64.

`bid_scaled` and `ask_scaled` are the strict parity basis. They must be generated from the persisted decimal lexical representation without silent rounding.

Canonical generation must preserve source row count, source order, exact duplicates, same-timestamp multi-ticks, Bid/Ask semantics, and nullable volume semantics.

Canonical Parquet production remains blocked until the precision gate is formally accepted for the symbol.

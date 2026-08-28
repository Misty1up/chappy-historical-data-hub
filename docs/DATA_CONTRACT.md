# Phase 1 Data Contract

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

Each JSONL record is serialized from SourceTick without price rounding. Snapshot gzip generation is deterministic so repeated serialization of identical SourceTick content yields identical bytes and SHA-256.

## Audit

A daily audit records tick count, timestamp bounds, duplicate/same-timestamp counts, out-of-order count, invalid-price count, negative-spread count, snapshot SHA-256 and status.

`PASS` means the Source Tick snapshot passed Phase 1 acquisition integrity checks. It does not mean the data is approved as Canonical or MT5-ready.

## Precision guard

`price_digits` and `price_scale` are not guessed. A symbol with `precision_status != VERIFIED` cannot be promoted to later Canonical/MT5 stages.

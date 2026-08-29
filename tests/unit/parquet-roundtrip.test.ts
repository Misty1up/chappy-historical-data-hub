import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalLogicalRowHash } from '../../src/canonical/logical-hash.js';
import type { CanonicalDayResult, CanonicalTick } from '../../src/canonical/types.js';
import { canonicalParquetPathForDay, writeCanonicalParquetDay } from '../../src/parquet/write.js';

const rows: CanonicalTick[] = [
  { timestamp_msc: 1767571200001n, source_seq: 0, bid: 1.1, ask: 1.10002, bid_scaled: 110000n, ask_scaled: 110002n, bid_volume: null, ask_volume: 1.25 },
  { timestamp_msc: 1767571200001n, source_seq: 1, bid: 1.1, ask: 1.10002, bid_scaled: 110000n, ask_scaled: 110002n, bid_volume: null, ask_volume: 1.25 },
  { timestamp_msc: 1767571200001n, source_seq: 2, bid: 1.10005, ask: 1.10008, bid_scaled: 110005n, ask_scaled: 110008n, bid_volume: 0, ask_volume: null },
  { timestamp_msc: 1767571200250n, source_seq: 3, bid: 1.09995, ask: 1.09999, bid_scaled: 109995n, ask_scaled: 109999n, bid_volume: 2.5, ask_volume: 0 },
  { timestamp_msc: 1767571200500n, source_seq: 4, bid: 1.1001, ask: 1.10012, bid_scaled: 110010n, ask_scaled: 110012n, bid_volume: 0.125, ask_volume: 3.75 },
  { timestamp_msc: 1767571200500n, source_seq: 5, bid: 1.10001, ask: 1.10003, bid_scaled: 110001n, ask_scaled: 110003n, bid_volume: 4.5, ask_volume: null },
];

function fixture(): CanonicalDayResult {
  return {
    symbol: 'EURUSD',
    date_utc: '2026-01-05',
    price_digits: 5,
    price_scale: 100000,
    source_snapshot_sha256: 'a'.repeat(64),
    source_row_count: rows.length,
    canonical_row_count: rows.length,
    first_timestamp_msc: rows[0]!.timestamp_msc.toString(),
    last_timestamp_msc: rows.at(-1)!.timestamp_msc.toString(),
    logical_row_sha256: canonicalLogicalRowHash(rows),
    rows,
  };
}

test('SNAPPY Canonical Parquet roundtrips exact semantic rows and logical hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-parquet-'));
  try {
    const canonical = fixture();
    const path = canonicalParquetPathForDay(root, canonical.symbol, canonical.date_utc);
    const first = await writeCanonicalParquetDay(canonical, path);

    assert.equal(first.resumed_existing, false);
    assert.equal(first.profile.codec, 'SNAPPY');
    assert.equal(first.profile.statistics, false);
    assert.equal(first.verification.row_count, rows.length);
    assert.equal(first.verification.schema_match, true);
    assert.equal(first.verification.semantic_rows_match, true);
    assert.equal(first.verification.logical_hash_match, true);
    assert.equal(first.verification.logical_row_sha256, canonical.logical_row_sha256);
    assert.match(first.physical_sha256, /^[0-9a-f]{64}$/);
    assert.ok(first.file_size_bytes > 0);

    const second = await writeCanonicalParquetDay(canonical, path);
    assert.equal(second.resumed_existing, true);
    assert.equal(second.physical_sha256, first.physical_sha256);
    assert.equal(second.verification.logical_row_sha256, canonical.logical_row_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

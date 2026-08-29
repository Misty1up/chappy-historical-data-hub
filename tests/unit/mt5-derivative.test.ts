import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalLogicalRowHash } from '../../src/canonical/logical-hash.js';
import type { CanonicalDayResult, CanonicalTick } from '../../src/canonical/types.js';
import { deriveMt5TickDerivativeDay, formatScaledPrice } from '../../src/mt5/derive.js';
import { serializeMt5DerivativeCsv, writeMt5DerivativeDay } from '../../src/mt5/write.js';

const rows: CanonicalTick[] = [
  { timestamp_msc: 1767571200001n, source_seq: 0, bid: 1.1, ask: 1.10002, bid_scaled: 110000n, ask_scaled: 110002n, bid_volume: null, ask_volume: 1.25 },
  { timestamp_msc: 1767571200001n, source_seq: 1, bid: 1.1, ask: 1.10002, bid_scaled: 110000n, ask_scaled: 110002n, bid_volume: null, ask_volume: 1.25 },
  { timestamp_msc: 1767571200001n, source_seq: 2, bid: 1.10005, ask: 1.10008, bid_scaled: 110005n, ask_scaled: 110008n, bid_volume: 0, ask_volume: null },
  { timestamp_msc: 1767571200250n, source_seq: 3, bid: 1.09995, ask: 1.09999, bid_scaled: 109995n, ask_scaled: 109999n, bid_volume: 2.5, ask_volume: 0 },
];

function fixture(fixtureRows: CanonicalTick[] = rows): CanonicalDayResult {
  return {
    symbol: 'EURUSD',
    date_utc: '2026-01-05',
    price_digits: 5,
    price_scale: 100000,
    source_snapshot_sha256: 'a'.repeat(64),
    source_row_count: fixtureRows.length,
    canonical_row_count: fixtureRows.length,
    first_timestamp_msc: fixtureRows[0]?.timestamp_msc.toString() ?? null,
    last_timestamp_msc: fixtureRows.at(-1)?.timestamp_msc.toString() ?? null,
    logical_row_sha256: canonicalLogicalRowHash(fixtureRows),
    rows: fixtureRows,
  };
}

test('scaled Canonical prices serialize with exact verified digits', () => {
  assert.equal(formatScaledPrice(110000n, 5), '1.10000');
  assert.equal(formatScaledPrice(1000n, 3), '1.000');
  assert.equal(formatScaledPrice(5n, 3), '0.005');
  assert.equal(formatScaledPrice(-5n, 3), '-0.005');
});

test('MT5 derivative preserves source order, duplicates, same timestamps and exact Bid/Ask', () => {
  const derivative = deriveMt5TickDerivativeDay(fixture());
  assert.equal(derivative.rows.length, rows.length);
  assert.deepEqual(derivative.rows.map(row => row.source_seq), [0, 1, 2, 3]);
  assert.deepEqual(derivative.rows.map(row => row.time_msc), rows.map(row => row.timestamp_msc));
  assert.equal(derivative.rows[0]!.bid, '1.10000');
  assert.equal(derivative.rows[0]!.ask, '1.10002');
  assert.equal(derivative.rows[0]!.time_msc, derivative.rows[1]!.time_msc);
  assert.equal(derivative.rows[0]!.bid_scaled, derivative.rows[1]!.bid_scaled);
  assert.equal(derivative.volume_mapping_policy, 'UNMAPPED_BID_ASK_VOLUME_REMAINS_CANONICAL_ONLY');
  assert.equal(derivative.dataset_binding_status, 'PENDING_P2_5_PACKET');

  const csv = serializeMt5DerivativeCsv(derivative);
  assert.equal(csv.split('\n')[0], 'time_msc,bid,ask,bid_scaled,ask_scaled,source_seq');
  assert.match(csv, /1767571200001,1\.10000,1\.10002,110000,110002,0/);
});

test('MT5 derivative rejects decreasing Canonical time instead of sorting', () => {
  const badRows: CanonicalTick[] = [
    rows[0]!,
    { ...rows[1]!, timestamp_msc: 1767571200000n },
  ];
  assert.throws(
    () => deriveMt5TickDerivativeDay(fixture(badRows)),
    /sorting is forbidden/,
  );
});

test('MT5 derivative text artifacts are deterministic and hash-verified on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-mt5-'));
  try {
    const derivative = deriveMt5TickDerivativeDay(fixture());
    const first = await writeMt5DerivativeDay(derivative, root);
    assert.equal(first.resumed_existing, false);
    assert.match(first.csv_physical_sha256, /^[0-9a-f]{64}$/);
    assert.match(first.contract_physical_sha256, /^[0-9a-f]{64}$/);
    assert.ok(first.csv_file_size_bytes > 0);
    assert.ok(first.contract_file_size_bytes > 0);

    const second = await writeMt5DerivativeDay(derivative, root);
    assert.equal(second.resumed_existing, true);
    assert.equal(second.csv_physical_sha256, first.csv_physical_sha256);
    assert.equal(second.contract_physical_sha256, first.contract_physical_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSourceTicks, readSourceSnapshot, writeSourceSnapshot } from '../../src/core/source-snapshot.js';
import type { SourceTick } from '../../src/types/contracts.js';

const fixture: SourceTick[] = [
  { timestamp_msc: 1700000000001n, bid: 1.12345, ask: 1.12347, bid_volume: null, ask_volume: 0.75, source_seq: 0 },
  { timestamp_msc: 1700000000001n, bid: 1.12345, ask: 1.12347, bid_volume: null, ask_volume: 0.75, source_seq: 1 },
];

test('gzip serialization is deterministic for identical SourceTick input', () => {
  const a = gzipSourceTicks(fixture);
  const b = gzipSourceTicks(fixture);
  assert.deepEqual(a, b);
});

test('snapshot preserves timestamp decimal string, null volume, duplicates and source order', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-test-'));
  try {
    const path = resolve(dir, 'ticks.jsonl.gz');
    await writeSourceSnapshot(path, fixture);
    const rows = await readSourceSnapshot(path);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.timestamp_msc, '1700000000001');
    assert.equal(rows[0]!.bid_volume, null);
    assert.equal(rows[0]!.source_seq, 0);
    assert.equal(rows[1]!.source_seq, 1);
    assert.deepEqual(rows[0]!.bid, rows[1]!.bid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

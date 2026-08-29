import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256File } from '../../src/core/hash.js';
import { convertSourceSnapshotToCanonicalDay } from '../../src/canonical/convert.js';
import { canonicalLogicalRowHash } from '../../src/canonical/logical-hash.js';
import type { SymbolRegistryEntry } from '../../src/types/contracts.js';

const verifiedSymbol: SymbolRegistryEntry = {
  canonical_symbol: 'EURUSD',
  enabled: true,
  source_adapter_id: 'dukascopy-node',
  source_instrument: 'eurusd',
  source_api_code: 'EUR-USD',
  source_api_code_provenance: 'fixture',
  source_feed_type: 'tick',
  source_start_hint_utc: '2003-05-04T00:00:00.000Z',
  source_start_hint_provenance: 'fixture',
  source_start_hint_status: 'REFERENCE_ONLY',
  precision_status: 'VERIFIED',
  price_digits: 5,
  price_scale: 100000,
};

const lines = [
  '{"timestamp_msc":"1767571200001","bid":1.23456,"ask":1.23458,"bid_volume":null,"ask_volume":12.5,"source_seq":0}',
  '{"timestamp_msc":"1767571200001","bid":1.23456,"ask":1.23458,"bid_volume":null,"ask_volume":12.5,"source_seq":1}',
  '{"timestamp_msc":"1767571200999","bid":1.23455,"ask":1.23457,"bid_volume":7,"ask_volume":null,"source_seq":2}',
];

async function withSnapshot(fn: (path: string, sha: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-canonical-'));
  try {
    const path = resolve(dir, '2026-01-05.jsonl.gz');
    const gz = Uint8Array.from(gzipSync(`${lines.join('\n')}\n`, { level: 9, mtime: 0 } as never));
    await writeFile(path, gz);
    await fn(path, await sha256File(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('canonical conversion preserves row count, order, duplicates and exact scaled prices', async () => {
  await withSnapshot(async (path, sha) => {
    const result = await convertSourceSnapshotToCanonicalDay({
      symbol: verifiedSymbol,
      dateUtc: '2026-01-05',
      sourceSnapshotPath: path,
      expectedSourceSnapshotSha256: sha,
      expectedSourceRowCount: 3,
    });

    assert.equal(result.source_row_count, 3);
    assert.equal(result.canonical_row_count, 3);
    assert.deepEqual(result.rows.map(row => row.source_seq), [0, 1, 2]);
    assert.equal(result.rows[0]!.timestamp_msc, result.rows[1]!.timestamp_msc);
    assert.equal(result.rows[0]!.bid_scaled, 123456n);
    assert.equal(result.rows[0]!.ask_scaled, 123458n);
    assert.equal(result.rows[2]!.bid_scaled, 123455n);
    assert.equal(result.rows[2]!.ask_scaled, 123457n);
    assert.equal(result.logical_row_sha256, canonicalLogicalRowHash(result.rows));
  });
});

test('canonical conversion is deterministic for identical Source Snapshot bytes', async () => {
  await withSnapshot(async (path, sha) => {
    const input = {
      symbol: verifiedSymbol,
      dateUtc: '2026-01-05',
      sourceSnapshotPath: path,
      expectedSourceSnapshotSha256: sha,
      expectedSourceRowCount: 3,
    } as const;
    const first = await convertSourceSnapshotToCanonicalDay(input);
    const second = await convertSourceSnapshotToCanonicalDay(input);
    assert.equal(first.logical_row_sha256, second.logical_row_sha256);
  });
});

test('canonical conversion refuses UNVERIFIED precision', async () => {
  await withSnapshot(async (path, sha) => {
    const unverified: SymbolRegistryEntry = {
      ...verifiedSymbol,
      precision_status: 'UNVERIFIED',
      price_digits: null,
      price_scale: null,
    };
    await assert.rejects(
      () => convertSourceSnapshotToCanonicalDay({
        symbol: unverified,
        dateUtc: '2026-01-05',
        sourceSnapshotPath: path,
        expectedSourceSnapshotSha256: sha,
        expectedSourceRowCount: 3,
      }),
      /requires VERIFIED precision/,
    );
  });
});

test('canonical conversion refuses prices off the declared verified lattice', async () => {
  await withSnapshot(async (path, sha) => {
    const wrongScale: SymbolRegistryEntry = {
      ...verifiedSymbol,
      price_digits: 4,
      price_scale: 10000,
    };
    await assert.rejects(
      () => convertSourceSnapshotToCanonicalDay({
        symbol: wrongScale,
        dateUtc: '2026-01-05',
        sourceSnapshotPath: path,
        expectedSourceSnapshotSha256: sha,
        expectedSourceRowCount: 3,
      }),
      /off verified price lattice/,
    );
  });
});

test('canonical conversion refuses source hash mismatch before row conversion', async () => {
  await withSnapshot(async path => {
    await assert.rejects(
      () => convertSourceSnapshotToCanonicalDay({
        symbol: verifiedSymbol,
        dateUtc: '2026-01-05',
        sourceSnapshotPath: path,
        expectedSourceSnapshotSha256: '0'.repeat(64),
        expectedSourceRowCount: 3,
      }),
      /Source snapshot SHA mismatch/,
    );
  });
});

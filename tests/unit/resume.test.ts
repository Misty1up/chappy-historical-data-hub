import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sha256File } from '../../src/core/hash.js';
import { verifyReusableSnapshot } from '../../src/core/resume.js';
import type { DailyAudit } from '../../src/types/contracts.js';

function audit(hash: string): DailyAudit {
  return {
    date_utc: '2026-01-01', status: 'PASS', tick_count: 1,
    first_timestamp_msc: '1', last_timestamp_msc: '1',
    exact_duplicate_count: 0, same_timestamp_pair_count: 0,
    out_of_order_count: 0, invalid_price_count: 0, negative_spread_count: 0,
    null_bid_volume_count: 0, null_ask_volume_count: 0,
    snapshot_path: 'snapshot', snapshot_sha256: hash,
    failure_class: null, note: null,
  };
}

test('resume requires matching snapshot hash', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-resume-'));
  try {
    const path = resolve(dir, 'snapshot');
    await writeFile(path, 'original');
    const hash = await sha256File(path);
    assert.equal(await verifyReusableSnapshot(audit(hash), path), true);
    await writeFile(path, 'tampered');
    await assert.rejects(() => verifyReusableSnapshot(audit(hash), path), /HASH_MISMATCH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySha256Sums } from '../../src/core/run-evidence.js';

test('SHA verification refuses relative paths escaping the run root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-sha-'));
  try {
    await writeFile(
      join(root, 'SHA256SUMS.txt'),
      `${'0'.repeat(64)}  ../../outside.txt\n`,
      'utf8',
    );
    const result = await verifySha256Sums(root);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.mismatches, ['../../outside.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

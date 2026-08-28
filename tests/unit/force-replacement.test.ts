import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { backupExistingFile } from '../../src/core/force-replacement.js';

test('backupExistingFile moves an existing snapshot to deterministic backup target', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-force-'));
  try {
    const path = resolve(dir, 'snapshot.jsonl.gz');
    await writeFile(path, 'old');
    const backup = await backupExistingFile(path, 'fixture');
    assert.equal(backup, `${path}.backup-fixture`);
    await assert.rejects(() => access(path));
    assert.equal(await readFile(backup!, 'utf8'), 'old');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backupExistingFile is a no-op when no file exists', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-force-missing-'));
  try {
    assert.equal(await backupExistingFile(resolve(dir, 'missing'), 'fixture'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

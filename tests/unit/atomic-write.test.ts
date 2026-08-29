import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../../src/core/atomic-write.js';

test('atomicWriteFile writes final content without leaving temp files', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-atomic-'));
  try {
    const path = resolve(dir, 'nested', 'value.txt');
    await atomicWriteFile(path, 'first');
    await atomicWriteFile(path, 'second');
    assert.equal(await readFile(path, 'utf8'), 'second');
    assert.deepEqual((await readdir(resolve(dir, 'nested'))).sort(), ['value.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

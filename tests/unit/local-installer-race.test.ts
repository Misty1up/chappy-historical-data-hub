import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from '../../src/core/atomic-write.js';
import { sha256File } from '../../src/core/hash.js';
import { buildSha256Sums } from '../../src/core/run-evidence.js';
import { LocalInstallError, importLocalDatasetPacket } from '../../src/local/installer.js';
import { hashEntriesRoot } from '../../src/packet/contract.js';

const DATASET_ID = `HDH_DATASET_V1_${'9'.repeat(64)}`;
const DATE_UTC = '2026-01-05';
const SOURCE_HASH_ROOT = 'a'.repeat(64);
const LOGICAL_HASH = 'b'.repeat(64);
const SOURCE_SHA = 'c'.repeat(64);
const CANONICAL_PATH = `canonical/EURUSD/2026/01/${DATE_UTC}.parquet`;
const MT5_PATH = `mt5/ticks/EURUSD/2026/01/${DATE_UTC}.ticks.csv`;

async function writePacket(packetRoot: string): Promise<void> {
  await atomicWriteFile(resolve(packetRoot, CANONICAL_PATH), 'canonical-race-fixture\n');
  await atomicWriteFile(
    resolve(packetRoot, MT5_PATH),
    'time_msc,bid,ask,bid_scaled,ask_scaled,source_seq\n1767571200001,1.1,1.10002,110000,110002,0\n',
  );
  const canonicalSha = await sha256File(resolve(packetRoot, CANONICAL_PATH));
  const mt5Sha = await sha256File(resolve(packetRoot, MT5_PATH));
  const canonicalSize = (await stat(resolve(packetRoot, CANONICAL_PATH))).size;
  const mt5Size = (await stat(resolve(packetRoot, MT5_PATH))).size;

  await atomicWriteFile(resolve(packetRoot, 'audit', 'precision_evidence.json'), `${JSON.stringify({
    symbol: 'EURUSD',
    candidate_price_digits: 5,
    candidate_price_scale: 100000,
    bid_scaled_conversion_fail_count: 0,
    ask_scaled_conversion_fail_count: 0,
    exact_lattice_pass: true,
    precision_status: 'VERIFIED',
  }, null, 2)}\n`);
  const precisionSha = await sha256File(resolve(packetRoot, 'audit', 'precision_evidence.json'));

  const canonicalRoot = hashEntriesRoot([{ key: DATE_UTC, sha256: LOGICAL_HASH }]);
  const parquetRoot = hashEntriesRoot([{ key: CANONICAL_PATH, sha256: canonicalSha }]);
  const mt5Root = hashEntriesRoot([{ key: MT5_PATH, sha256: mt5Sha }]);
  const parquetBinding = {
    date_utc: DATE_UTC,
    path: CANONICAL_PATH,
    physical_sha256: canonicalSha,
    file_size_bytes: canonicalSize,
    canonical_logical_row_hash: LOGICAL_HASH,
    row_count: 1,
    source_snapshot_sha256: SOURCE_SHA,
  };
  const mt5Binding = {
    date_utc: DATE_UTC,
    path: MT5_PATH,
    physical_sha256: mt5Sha,
    file_size_bytes: mt5Size,
    canonical_logical_row_hash: LOGICAL_HASH,
    row_count: 1,
    source_snapshot_sha256: SOURCE_SHA,
  };
  const manifest = {
    manifest_schema_version: '0.1.0',
    dataset_id: DATASET_ID,
    canonical_schema_version: '0.1',
    generator_git_commit: 'd'.repeat(40),
    source_run_id: 'HDH_EURUSD_RACE_FIXTURE',
    source_hash_root: SOURCE_HASH_ROOT,
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    tick_count_total: 1,
    canonical_file_count: 1,
    price_digits: 5,
    price_scale: 100000,
    precision_status: 'VERIFIED',
    precision_evidence_sha256: precisionSha,
    canonical_logical_hash_root: canonicalRoot,
    parquet_file_hash_root: parquetRoot,
    mt5_derivative_hash_root: mt5Root,
    integrity_status: 'PASS',
    canonical_promotion_allowed: true,
    generated_at_utc: '2026-08-31T00:00:00.000Z',
  };
  const common = {
    schema_version: '0.1.0',
    dataset_id: DATASET_ID,
    dataset_binding_status: 'BOUND_P2_5_PACKET',
    canonical_schema_version: '0.1',
    symbol: 'EURUSD',
    requested_from_utc: manifest.requested_from_utc,
    requested_to_utc: manifest.requested_to_utc,
    source_hash_root: SOURCE_HASH_ROOT,
    canonical_logical_hash_root: canonicalRoot,
    price_digits: 5,
    price_scale: 100000,
  };
  await atomicWriteFile(resolve(packetRoot, 'numba', 'dataset.json'), `${JSON.stringify({
    ...common,
    parquet_files: [parquetBinding],
  }, null, 2)}\n`);
  await atomicWriteFile(resolve(packetRoot, 'mt5', 'symbol_contract.json'), `${JSON.stringify({
    ...common,
    profile_id: 'HDH_MT5_DERIVATIVE_V1',
    tick_files: [mt5Binding],
  }, null, 2)}\n`);
  await atomicWriteFile(resolve(packetRoot, 'audit', 'canonical_daily_audit.jsonl'), `${JSON.stringify({
    symbol: 'EURUSD',
    date_utc: DATE_UTC,
    source_snapshot_sha256: SOURCE_SHA,
    source_tick_count: 1,
    canonical_tick_count: 1,
    bid_scaled_conversion_fail_count: 0,
    ask_scaled_conversion_fail_count: 0,
    parquet_sha256: canonicalSha,
    canonical_logical_row_hash: LOGICAL_HASH,
    source_order_preservation: 'PASS',
    hash_chain_status: 'PASS',
    status: 'PASS',
  })}\n`);
  await atomicWriteFile(resolve(packetRoot, 'audit', 'integrity_report.json'), `${JSON.stringify({
    schema_version: '0.1.0',
    dataset_id: DATASET_ID,
    source_hash_root: SOURCE_HASH_ROOT,
    precision_evidence_sha256: precisionSha,
    precision_status: 'VERIFIED',
    precision_binding_verified: true,
    canonical_daily_audit_count: 1,
    canonical_daily_pass_count: 1,
    canonical_logical_hash_root: canonicalRoot,
    parquet_file_hash_root: parquetRoot,
    mt5_derivative_hash_root: mt5Root,
    numba_binding_status: 'BOUND_P2_5_PACKET',
    mt5_binding_status: 'BOUND_P2_5_PACKET',
    hash_chain_status: 'PASS',
    integrity_status: 'PASS',
    canonical_promotion_allowed: true,
  }, null, 2)}\n`);
  await atomicWriteFile(resolve(packetRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await atomicWriteFile(resolve(packetRoot, 'README.md'), '# P5.2 no-clobber race fixture\n');
  await buildSha256Sums(packetRoot);
}

async function assertStagingEmpty(localRoot: string): Promise<void> {
  const staging = resolve(localRoot, '.staging');
  try {
    assert.deepEqual(await readdir(staging), []);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

test('P5.2 publish race never replaces an unexpected empty destination directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-race-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writePacket(source);
    const finalDatasetRoot = resolve(localRoot, 'datasets', DATASET_ID);

    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot, {
        beforePublish: async expectedFinalDatasetRoot => {
          assert.equal(expectedFinalDatasetRoot, finalDatasetRoot);
          await mkdir(finalDatasetRoot, { recursive: false });
        },
      }),
      (cause: unknown) => cause instanceof LocalInstallError
        && cause.code === 'DESTINATION_ALREADY_EXISTS_UNEXPECTED',
    );

    assert.deepEqual(await readdir(finalDatasetRoot), []);
    await assert.rejects(stat(resolve(finalDatasetRoot, 'DATA_PACKET')), { code: 'ENOENT' });
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 interrupted staged operation cleans only tool staging and publishes no final DATA_PACKET', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-interrupt-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writePacket(source);

    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot, {
        afterMaterialize: async () => {
          throw new Error('simulated interrupted local copy workflow');
        },
      }),
      /simulated interrupted local copy workflow/,
    );

    await assert.rejects(stat(resolve(localRoot, 'datasets', DATASET_ID, 'DATA_PACKET')), { code: 'ENOENT' });
    assert.ok(await stat(source));
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

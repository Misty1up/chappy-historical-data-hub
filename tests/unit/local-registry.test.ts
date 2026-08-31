import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from '../../src/core/atomic-write.js';
import { sha256File } from '../../src/core/hash.js';
import { buildSha256Sums } from '../../src/core/run-evidence.js';
import { importLocalDatasetPacket } from '../../src/local/installer.js';
import {
  LOCAL_REGISTRY_SCHEMA_VERSION,
  LocalRegistryError,
  adoptInstalledDataset,
  importAndRegisterLocalDatasetPacket,
  listRegisteredDatasets,
  showRegisteredDataset,
  verifyRegisteredDataset,
} from '../../src/local/registry.js';
import { hashEntriesRoot } from '../../src/packet/contract.js';

const DATASET_ID = `HDH_DATASET_V1_${'5'.repeat(64)}`;
const DATE_UTC = '2026-01-05';
const SOURCE_HASH_ROOT = '6'.repeat(64);
const CANONICAL_LOGICAL_ROW_HASH = '7'.repeat(64);
const SOURCE_SNAPSHOT_SHA = '8'.repeat(64);
const CANONICAL_PATH = `canonical/EURUSD/2026/01/${DATE_UTC}.parquet`;
const MT5_PATH = `mt5/ticks/EURUSD/2026/01/${DATE_UTC}.ticks.csv`;

async function writeSyntheticPacket(packetRoot: string): Promise<void> {
  await atomicWriteFile(resolve(packetRoot, CANONICAL_PATH), 'synthetic-canonical-payload\n');
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

  const parquetBinding = {
    date_utc: DATE_UTC,
    path: CANONICAL_PATH,
    physical_sha256: canonicalSha,
    file_size_bytes: canonicalSize,
    canonical_logical_row_hash: CANONICAL_LOGICAL_ROW_HASH,
    row_count: 2,
    source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
  };
  const mt5Binding = {
    date_utc: DATE_UTC,
    path: MT5_PATH,
    physical_sha256: mt5Sha,
    file_size_bytes: mt5Size,
    canonical_logical_row_hash: CANONICAL_LOGICAL_ROW_HASH,
    row_count: 2,
    source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
  };
  const canonicalRoot = hashEntriesRoot([{ key: DATE_UTC, sha256: CANONICAL_LOGICAL_ROW_HASH }]);
  const parquetRoot = hashEntriesRoot([{ key: CANONICAL_PATH, sha256: canonicalSha }]);
  const mt5Root = hashEntriesRoot([{ key: MT5_PATH, sha256: mt5Sha }]);

  const manifest = {
    manifest_schema_version: '0.1.0',
    dataset_id: DATASET_ID,
    canonical_schema_version: '0.1',
    generator_git_commit: 'a'.repeat(40),
    source_run_id: 'HDH_EURUSD_20260105_20260106',
    source_hash_root: SOURCE_HASH_ROOT,
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    tick_count_total: 2,
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
  const commonBinding = {
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
    ...commonBinding,
    parquet_files: [parquetBinding],
  }, null, 2)}\n`);
  await atomicWriteFile(resolve(packetRoot, 'mt5', 'symbol_contract.json'), `${JSON.stringify({
    ...commonBinding,
    profile_id: 'HDH_MT5_DERIVATIVE_V1',
    tick_files: [mt5Binding],
  }, null, 2)}\n`);
  await atomicWriteFile(resolve(packetRoot, 'audit', 'canonical_daily_audit.jsonl'), `${JSON.stringify({
    symbol: 'EURUSD',
    date_utc: DATE_UTC,
    source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
    source_tick_count: 2,
    canonical_tick_count: 2,
    bid_scaled_conversion_fail_count: 0,
    ask_scaled_conversion_fail_count: 0,
    parquet_sha256: canonicalSha,
    canonical_logical_row_hash: CANONICAL_LOGICAL_ROW_HASH,
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
  await atomicWriteFile(resolve(packetRoot, 'README.md'), '# Synthetic P5.3 Dataset Packet\n');
  await buildSha256Sums(packetRoot);
}

function registryErrorCode(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalRegistryError && cause.code === code;
}

test('P5.3 integrated import publishes one verified Packet and transactionally registers one row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-import-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local registry 日本語');
    await writeSyntheticPacket(source);

    const first = await importAndRegisterLocalDatasetPacket(source, localRoot);
    assert.equal(first.local_import_status, 'IMPORTED');
    assert.equal(first.filesystem_mutation_performed, true);
    assert.equal(first.registry_mutation_performed, true);
    assert.equal(first.registry_schema_version, LOCAL_REGISTRY_SCHEMA_VERSION);

    const listed = await listRegisteredDatasets(localRoot);
    assert.equal(listed.registry_file_status, 'PRESENT');
    assert.equal(listed.datasets.length, 1);
    assert.equal(listed.datasets[0]!.dataset_id, DATASET_ID);
    assert.equal(listed.datasets[0]!.source_transport_type, 'DIRECTORY');

    const shown = await showRegisteredDataset(localRoot, DATASET_ID);
    assert.equal(shown.dataset.local_packet_path, first.final_packet_path);
    const verified = await verifyRegisteredDataset(localRoot, DATASET_ID);
    assert.equal(verified.registry_verify_status, 'PASS');

    const second = await importAndRegisterLocalDatasetPacket(source, localRoot);
    assert.equal(second.local_import_status, 'ALREADY_REGISTERED');
    assert.equal(second.filesystem_mutation_performed, false);
    assert.equal(second.registry_mutation_performed, false);
    assert.equal((await listRegisteredDatasets(localRoot)).datasets.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.3 explicit adopt registers a valid P5.2 orphan and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-adopt-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const p52 = await importLocalDatasetPacket(source, localRoot);
    assert.equal(p52.local_import_status, 'IMPORTED');

    const before = await listRegisteredDatasets(localRoot);
    assert.equal(before.registry_file_status, 'NOT_PRESENT');

    const adopted = await adoptInstalledDataset(localRoot, DATASET_ID);
    assert.equal(adopted.local_import_status, 'IMPORTED');
    assert.equal(adopted.filesystem_mutation_performed, false);
    assert.equal(adopted.registry_mutation_performed, true);

    const again = await adoptInstalledDataset(localRoot, DATASET_ID);
    assert.equal(again.local_import_status, 'ALREADY_REGISTERED');
    assert.equal(again.registry_mutation_performed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.3 integrated import HOLDs an unregistered valid final and requires explicit adopt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-orphan-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await importLocalDatasetPacket(source, localRoot);

    await assert.rejects(
      () => importAndRegisterLocalDatasetPacket(source, localRoot),
      registryErrorCode('LOCAL_REGISTRY_INCONSISTENT'),
    );
    assert.equal((await listRegisteredDatasets(localRoot)).datasets.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.3 verify detects registered Packet corruption without rewriting row or Packet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-corrupt-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const imported = await importAndRegisterLocalDatasetPacket(source, localRoot);
    await atomicWriteFile(resolve(imported.final_packet_path, CANONICAL_PATH), 'tampered-local-packet\n');

    await assert.rejects(
      () => verifyRegisteredDataset(localRoot, DATASET_ID),
      registryErrorCode('LOCAL_REGISTRY_INCONSISTENT'),
    );
    assert.equal(await readFile(resolve(imported.final_packet_path, CANONICAL_PATH), 'utf8'), 'tampered-local-packet\n');
    assert.equal((await listRegisteredDatasets(localRoot)).datasets.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.3 transaction failure rolls back registration and keeps the valid orphan for reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-rollback-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const p52 = await importLocalDatasetPacket(source, localRoot);

    await assert.rejects(
      () => adoptInstalledDataset(localRoot, DATASET_ID, {
        beforeCommit: () => {
          throw new Error('synthetic transaction interruption');
        },
      }),
      registryErrorCode('REGISTRY_TRANSACTION_FAIL'),
    );

    assert.equal((await listRegisteredDatasets(localRoot)).datasets.length, 0);
    assert.equal((await stat(p52.final_packet_path)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.3 exclusive lock refuses concurrent registry mutation and never auto-deletes the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-lock-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await importLocalDatasetPacket(source, localRoot);
    const lockPath = resolve(localRoot, 'registry', 'hdh_registry.lock');
    await mkdir(resolve(localRoot, 'registry'), { recursive: true });
    await atomicWriteFile(lockPath, 'external-lock\n');

    await assert.rejects(
      () => adoptInstalledDataset(localRoot, DATASET_ID),
      registryErrorCode('REGISTRY_LOCKED'),
    );
    assert.equal(await readFile(lockPath, 'utf8'), 'external-lock\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.3 show on an absent registry is read-only and reports DATASET_NOT_REGISTERED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p53-empty-'));
  try {
    const localRoot = resolve(root, 'local');
    const listed = await listRegisteredDatasets(localRoot);
    assert.equal(listed.registry_file_status, 'NOT_PRESENT');
    assert.deepEqual(listed.datasets, []);
    await assert.rejects(
      () => showRegisteredDataset(localRoot, DATASET_ID),
      registryErrorCode('DATASET_NOT_REGISTERED'),
    );
    await assert.rejects(stat(resolve(localRoot, 'registry', 'hdh_registry.sqlite')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

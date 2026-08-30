import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { atomicWriteFile, type BinaryBytes } from '../../src/core/atomic-write.js';
import { sha256File } from '../../src/core/hash.js';
import { buildSha256Sums } from '../../src/core/run-evidence.js';
import { LocalInstallError, importLocalDatasetPacket } from '../../src/local/installer.js';
import { scanLocalDatasetPacket } from '../../src/local/packet-verifier.js';
import { hashEntriesRoot } from '../../src/packet/contract.js';

const DATASET_ID = `HDH_DATASET_V1_${'5'.repeat(64)}`;
const DATE_UTC = '2026-01-05';
const SOURCE_HASH_ROOT = '6'.repeat(64);
const CANONICAL_LOGICAL_ROW_HASH = '7'.repeat(64);
const SOURCE_SNAPSHOT_SHA = '8'.repeat(64);
const CANONICAL_PATH = `canonical/EURUSD/2026/01/${DATE_UTC}.parquet`;
const MT5_PATH = `mt5/ticks/EURUSD/2026/01/${DATE_UTC}.ticks.csv`;

function bytes(value: ArrayLike<number>): BinaryBytes {
  return Uint8Array.from(value);
}

function utf8(value: string): BinaryBytes {
  return bytes(new TextEncoder().encode(value));
}

function concat(parts: readonly BinaryBytes[]): BinaryBytes {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function buffer(size: number): { bytes: BinaryBytes; view: DataView } {
  const raw = new ArrayBuffer(size);
  return { bytes: new Uint8Array(raw), view: new DataView(raw) };
}

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
  await atomicWriteFile(resolve(packetRoot, 'README.md'), '# Synthetic P5.2 Dataset Packet\n');
  await buildSha256Sums(packetRoot);
}

async function walkFiles(root: string, current = root): Promise<{ path: string; content: BinaryBytes }[]> {
  const files: { path: string; content: BinaryBytes }[] = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) files.push({ path: relative(root, absolute).replaceAll('\\', '/'), content: bytes(await readFile(absolute)) });
  }
  return files;
}

function storedZip(entries: { name: string; content: BinaryBytes }[]): BinaryBytes {
  const localParts: BinaryBytes[] = [];
  const centralParts: BinaryBytes[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = utf8(entry.name);
    const local = buffer(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint32(10, 0, true);
    local.view.setUint32(14, 0, true);
    local.view.setUint32(18, entry.content.length, true);
    local.view.setUint32(22, entry.content.length, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    localParts.push(local.bytes, name, entry.content);

    const central = buffer(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, (3 << 8) | 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint32(12, 0, true);
    central.view.setUint32(16, 0, true);
    central.view.setUint32(20, entry.content.length, true);
    central.view.setUint32(24, entry.content.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint16(30, 0, true);
    central.view.setUint16(32, 0, true);
    central.view.setUint16(34, 0, true);
    central.view.setUint16(36, 0, true);
    central.view.setUint32(38, ((0o100644 & 0xffff) * 0x10000) >>> 0, true);
    central.view.setUint32(42, localOffset, true);
    centralParts.push(central.bytes, name);
    localOffset += local.bytes.length + name.length + entry.content.length;
  }
  const centralDirectory = concat(centralParts);
  const end = buffer(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(4, 0, true);
  end.view.setUint16(6, 0, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralDirectory.length, true);
  end.view.setUint32(16, localOffset, true);
  end.view.setUint16(20, 0, true);
  return concat([...localParts, centralDirectory, end.bytes]);
}

function installErrorCode(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalInstallError && cause.code === code;
}

async function assertStagingEmpty(localRoot: string): Promise<void> {
  const staging = resolve(localRoot, '.staging');
  try {
    assert.deepEqual(await readdir(staging), []);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

test('P5.2 COPY ONLY imports a valid directory Packet, preserves source, and publishes exact verified bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-dir-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'ローカル HDH data');
    await writeSyntheticPacket(source);
    const sourceSumsBefore = await sha256File(resolve(source, 'SHA256SUMS.txt'));

    const result = await importLocalDatasetPacket(source, localRoot);
    assert.equal(result.local_import_status, 'IMPORTED');
    assert.equal(result.mutation_performed, true);
    assert.equal(result.registry_mutation_performed, false);
    assert.equal(result.dataset_id, DATASET_ID);
    const final = await scanLocalDatasetPacket(result.final_packet_path, localRoot);
    assert.equal(final.sha256sums_sha256, result.sha256sums_sha256);
    assert.equal(await sha256File(resolve(source, 'SHA256SUMS.txt')), sourceSumsBefore);
    await assert.rejects(stat(resolve(localRoot, 'registry', 'hdh_registry.sqlite')), { code: 'ENOENT' });
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 exact reimport returns ALREADY_REGISTERED no-op without a second copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-idempotent-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const first = await importLocalDatasetPacket(source, localRoot);
    const second = await importLocalDatasetPacket(source, localRoot);
    assert.equal(first.local_import_status, 'IMPORTED');
    assert.equal(second.local_import_status, 'ALREADY_REGISTERED');
    assert.equal(second.mutation_performed, false);
    assert.equal(second.import_run_id, null);
    assert.deepEqual(await readdir(resolve(localRoot, 'datasets')), [DATASET_ID]);
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 same dataset_id with corrupted existing final STOPs and never overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-conflict-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const first = await importLocalDatasetPacket(source, localRoot);
    await atomicWriteFile(resolve(first.final_packet_path, CANONICAL_PATH), 'corrupt-existing-final\n');
    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot),
      installErrorCode('DATASET_ID_COLLISION_OR_LOCAL_CORRUPTION'),
    );
    assert.equal(await readFile(resolve(first.final_packet_path, CANONICAL_PATH), 'utf8'), 'corrupt-existing-final\n');
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 post-copy tamper fails staged revalidation and publishes no final dataset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-stagefail-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot, {
        afterMaterialize: async stagingPacket => {
          await atomicWriteFile(resolve(stagingPacket, CANONICAL_PATH), 'post-copy-tamper\n');
        },
      }),
      installErrorCode('STAGING_VERIFY_FAIL'),
    );
    await assert.rejects(stat(resolve(localRoot, 'datasets', DATASET_ID)), { code: 'ENOENT' });
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 imports a validated Artifact-style ZIP without extracting outside staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-zip-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    await writeSyntheticPacket(source);
    const packetFiles = await walkFiles(source);
    const zip = storedZip([
      ...packetFiles.map(file => ({ name: `DATA_PACKET/${file.path}`, content: file.content })),
      { name: 'action_result.json', content: utf8('{"status":"PASS"}\n') },
    ]);
    const zipPath = resolve(root, 'artifact.zip');
    await atomicWriteFile(zipPath, zip);
    const localRoot = resolve(root, 'ZIP Import 日本語');
    const result = await importLocalDatasetPacket(zipPath, localRoot);
    assert.equal(result.local_import_status, 'IMPORTED');
    assert.equal(result.input_type, 'ZIP');
    const final = await scanLocalDatasetPacket(result.final_packet_path, localRoot);
    assert.equal(final.dataset_id, DATASET_ID);
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 HOLDs unexpected destination shell instead of deleting or repairing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-shell-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await mkdir(resolve(localRoot, 'datasets', DATASET_ID), { recursive: true });
    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot),
      installErrorCode('DESTINATION_ALREADY_EXISTS_UNEXPECTED'),
    );
    assert.deepEqual(await readdir(resolve(localRoot, 'datasets', DATASET_ID)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 refuses to interpret an existing SQLite registry before the P5.3 gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-registry-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await atomicWriteFile(resolve(localRoot, 'registry', 'hdh_registry.sqlite'), 'not-a-real-registry');
    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot),
      installErrorCode('LOCAL_REGISTRY_INCONSISTENT'),
    );
    await assert.rejects(stat(resolve(localRoot, 'datasets', DATASET_ID)), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.2 rejects a local root inside the selected source directory tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p52-root-safety-'));
  try {
    const selected = resolve(root, 'selected');
    const source = resolve(selected, 'DATA_PACKET');
    await writeSyntheticPacket(source);
    await assert.rejects(
      () => importLocalDatasetPacket(selected, resolve(selected, 'local-output')),
      installErrorCode('WINDOWS_PATH_UNSAFE'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { atomicWriteFile, type BinaryBytes } from '../../src/core/atomic-write.js';
import { sha256File } from '../../src/core/hash.js';
import { buildSha256Sums } from '../../src/core/run-evidence.js';
import { hashEntriesRoot } from '../../src/packet/contract.js';
import { LocalPacketError, scanLocalDatasetPacket } from '../../src/local/packet-verifier.js';

const DATASET_ID = `HDH_DATASET_V1_${'1'.repeat(64)}`;
const DATE_UTC = '2026-01-05';
const SOURCE_HASH_ROOT = '2'.repeat(64);
const CANONICAL_LOGICAL_ROW_HASH = '3'.repeat(64);
const SOURCE_SNAPSHOT_SHA = '4'.repeat(64);
const CANONICAL_PATH = `canonical/EURUSD/2026/01/${DATE_UTC}.parquet`;
const MT5_PATH = `mt5/ticks/EURUSD/2026/01/${DATE_UTC}.ticks.csv`;

function binary(data: ArrayLike<number>): BinaryBytes {
  return Uint8Array.from(data);
}

function utf8(text: string): BinaryBytes {
  return binary(Buffer.from(text, 'utf8'));
}

async function writeSyntheticPacket(packetRoot: string): Promise<void> {
  const canonicalPayload = 'synthetic-canonical-parquet-fixture\n';
  const mt5Payload = 'time_msc,bid,ask,bid_scaled,ask_scaled,source_seq\n1767571200001,1.1,1.10002,110000,110002,0\n';
  await atomicWriteFile(resolve(packetRoot, CANONICAL_PATH), canonicalPayload);
  await atomicWriteFile(resolve(packetRoot, MT5_PATH), mt5Payload);
  const canonicalSha = await sha256File(resolve(packetRoot, CANONICAL_PATH));
  const mt5Sha = await sha256File(resolve(packetRoot, MT5_PATH));
  const canonicalSize = (await stat(resolve(packetRoot, CANONICAL_PATH))).size;
  const mt5Size = (await stat(resolve(packetRoot, MT5_PATH))).size;

  const precision = {
    symbol: 'EURUSD',
    candidate_price_digits: 5,
    candidate_price_scale: 100000,
    bid_scaled_conversion_fail_count: 0,
    ask_scaled_conversion_fail_count: 0,
    exact_lattice_pass: true,
    precision_status: 'VERIFIED',
  };
  await atomicWriteFile(resolve(packetRoot, 'audit', 'precision_evidence.json'), `${JSON.stringify(precision, null, 2)}\n`);
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
    generated_at_utc: '2026-08-30T12:00:00.000Z',
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
  await atomicWriteFile(resolve(packetRoot, 'README.md'), '# Synthetic Phase 5 Packet Fixture\n');
  await buildSha256Sums(packetRoot);
}

async function walkFiles(root: string, current = root): Promise<{ path: string; bytes: BinaryBytes }[]> {
  const rows: { path: string; bytes: BinaryBytes }[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) rows.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) rows.push({ path: relative(root, absolute).replaceAll('\\', '/'), bytes: binary(await readFile(absolute)) });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function storedZip(entries: { name: string; bytes: BinaryBytes }[]): BinaryBytes {
  const localParts: BinaryBytes[] = [];
  const centralParts: BinaryBytes[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(binary(local), binary(name), entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100644 & 0xffff) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(binary(central), binary(name));
    localOffset += local.length + name.length + entry.bytes.length;
  }
  const centralDirectory = binary(Buffer.concat(centralParts));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return binary(Buffer.concat([...localParts, centralDirectory, binary(eocd)]));
}

function isLocalError(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalPacketError && cause.code === code;
}

test('P5.1 scans and fully revalidates one explicit directory Packet without mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p5-dir-'));
  try {
    const packet = resolve(root, 'download', 'DATA_PACKET');
    const localRoot = resolve(root, 'Local HDH データ');
    await writeSyntheticPacket(packet);
    const result = await scanLocalDatasetPacket(resolve(root, 'download'), localRoot);
    assert.equal(result.local_import_status, 'VALIDATED');
    assert.equal(result.mutation_performed, false);
    assert.equal(result.input_type, 'DIRECTORY');
    assert.equal(result.dataset_id, DATASET_ID);
    assert.equal(result.sha256_mismatch_count, 0);
    assert.equal(result.sha256sums_checked_files, result.packet_file_count - 1);
    assert.equal(result.registry_file_status, 'NOT_PRESENT');
    await assert.rejects(stat(localRoot), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.1 rejects one-byte Packet tamper before any local publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p5-tamper-'));
  try {
    const packet = resolve(root, 'DATA_PACKET');
    await writeSyntheticPacket(packet);
    await atomicWriteFile(resolve(packet, CANONICAL_PATH), 'tampered\n');
    await assert.rejects(() => scanLocalDatasetPacket(packet, resolve(root, 'local')), isLocalError('SHA256_MISMATCH'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.1 HOLDs ambiguous directory discovery instead of silently choosing a Packet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p5-ambiguous-'));
  try {
    await writeSyntheticPacket(resolve(root, 'a', 'DATA_PACKET'));
    await writeSyntheticPacket(resolve(root, 'b', 'DATA_PACKET'));
    await assert.rejects(() => scanLocalDatasetPacket(root, resolve(root, 'local')), isLocalError('AMBIGUOUS_PACKET_DISCOVERY'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.1 scans a downloaded Artifact-style ZIP containing DATA_PACKET plus transport sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p5-zip-'));
  try {
    const packet = resolve(root, 'fixture', 'DATA_PACKET');
    await writeSyntheticPacket(packet);
    const packetFiles = await walkFiles(packet);
    const zip = storedZip([
      ...packetFiles.map(file => ({ name: `DATA_PACKET/${file.path}`, bytes: file.bytes })),
      { name: 'action_result.json', bytes: utf8('{"status":"PASS"}\n') },
    ]);
    const zipPath = resolve(root, 'artifact.zip');
    await writeFile(zipPath, zip);
    const result = await scanLocalDatasetPacket(zipPath, resolve(root, 'ローカル HDH'));
    assert.equal(result.local_import_status, 'VALIDATED');
    assert.equal(result.input_type, 'ZIP');
    assert.equal(result.dataset_id, DATASET_ID);
    assert.match(result.resolved_packet_root, /::DATA_PACKET$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.1 rejects ZIP traversal before Packet discovery or validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p5-zipslip-'));
  try {
    const zipPath = resolve(root, 'unsafe.zip');
    await writeFile(zipPath, storedZip([
      { name: '../escape.txt', bytes: utf8('x') },
      { name: 'DATA_PACKET/manifest.json', bytes: utf8('{}\n') },
    ]));
    await assert.rejects(() => scanLocalDatasetPacket(zipPath, resolve(root, 'local')), isLocalError('UNSAFE_ARCHIVE_ENTRY'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.1 rejects a Packet whose accepted integrity status was changed even when SHA coverage is regenerated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p5-integrity-'));
  try {
    const packet = resolve(root, 'DATA_PACKET');
    await writeSyntheticPacket(packet);
    const manifestPath = resolve(packet, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.integrity_status = 'FAIL';
    await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await buildSha256Sums(packet);
    await assert.rejects(() => scanLocalDatasetPacket(packet, resolve(root, 'local')), isLocalError('INTEGRITY_NOT_ACCEPTED'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

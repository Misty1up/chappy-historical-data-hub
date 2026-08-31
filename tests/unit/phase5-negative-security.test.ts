import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { atomicWriteFile, type BinaryBytes } from '../../src/core/atomic-write.js';
import { sha256File } from '../../src/core/hash.js';
import { buildSha256Sums } from '../../src/core/run-evidence.js';
import { buildLocalConsumerHandoff } from '../../src/local/handoff.js';
import { LocalInstallError, importLocalDatasetPacket } from '../../src/local/installer.js';
import { LocalPacketError, scanLocalDatasetPacket } from '../../src/local/packet-verifier.js';
import {
  LocalRegistryError,
  importAndRegisterLocalDatasetPacket,
  listRegisteredDatasets,
} from '../../src/local/registry.js';
import { hashEntriesRoot } from '../../src/packet/contract.js';

const DATASET_ID = `HDH_DATASET_V1_${'a'.repeat(64)}`;
const DATE_UTC = '2026-01-05';
const SOURCE_HASH_ROOT = 'b'.repeat(64);
const CANONICAL_LOGICAL_ROW_HASH = 'c'.repeat(64);
const SOURCE_SNAPSHOT_SHA = 'd'.repeat(64);
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

function binaryBuffer(size: number): { bytes: BinaryBytes; view: DataView } {
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
    generator_git_commit: 'e'.repeat(40),
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
  await atomicWriteFile(resolve(packetRoot, 'README.md'), '# Synthetic P5.6 Dataset Packet\n');
  await buildSha256Sums(packetRoot);
}

async function packetFiles(root: string, current = root): Promise<{ path: string; content: BinaryBytes }[]> {
  const files: { path: string; content: BinaryBytes }[] = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await packetFiles(root, absolute));
    else if (entry.isFile()) files.push({
      path: relative(root, absolute).replaceAll('\\', '/'),
      content: bytes(await readFile(absolute)),
    });
  }
  return files;
}

function storedZip(entries: { name: string; content: BinaryBytes; unixMode?: number }[]): BinaryBytes {
  const localParts: BinaryBytes[] = [];
  const centralParts: BinaryBytes[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = utf8(entry.name);
    const local = binaryBuffer(30);
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

    const central = binaryBuffer(46);
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
    central.view.setUint32(38, (((entry.unixMode ?? 0o100644) & 0xffff) * 0x10000) >>> 0, true);
    central.view.setUint32(42, localOffset, true);
    centralParts.push(central.bytes, name);
    localOffset += local.bytes.length + name.length + entry.content.length;
  }
  const centralDirectory = concat(centralParts);
  const end = binaryBuffer(22);
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

function packetErrorCode(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalPacketError && cause.code === code;
}

function installErrorCode(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalInstallError && cause.code === code;
}

function registryErrorCode(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalRegistryError && cause.code === code;
}

async function assertStagingEmpty(localRoot: string): Promise<void> {
  const staging = resolve(localRoot, '.staging');
  try {
    assert.deepEqual(await readdir(staging), []);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

async function mutateJson(path: string, mutator: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  mutator(value);
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readSource(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8');
}

test('P5.6 rejects missing Packet, missing/malformed manifest, and missing/malformed SHA256SUMS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-metadata-'));
  try {
    await assert.rejects(
      () => scanLocalDatasetPacket(resolve(root, 'missing'), resolve(root, 'local')),
      packetErrorCode('PACKET_NOT_FOUND'),
    );

    const missingManifest = resolve(root, 'missing-manifest', 'DATA_PACKET');
    await writeSyntheticPacket(missingManifest);
    await rm(resolve(missingManifest, 'manifest.json'));
    await assert.rejects(
      () => scanLocalDatasetPacket(missingManifest, resolve(root, 'local-a')),
      packetErrorCode('MANIFEST_MISSING'),
    );

    const malformedManifest = resolve(root, 'malformed-manifest', 'DATA_PACKET');
    await writeSyntheticPacket(malformedManifest);
    await atomicWriteFile(resolve(malformedManifest, 'manifest.json'), '{not-json\n');
    await assert.rejects(
      () => scanLocalDatasetPacket(malformedManifest, resolve(root, 'local-b')),
      packetErrorCode('MANIFEST_PARSE_FAIL'),
    );

    const missingSums = resolve(root, 'missing-sums', 'DATA_PACKET');
    await writeSyntheticPacket(missingSums);
    await rm(resolve(missingSums, 'SHA256SUMS.txt'));
    await assert.rejects(
      () => scanLocalDatasetPacket(missingSums, resolve(root, 'local-c')),
      packetErrorCode('SHA256SUMS_MISSING'),
    );

    const malformedSums = resolve(root, 'malformed-sums', 'DATA_PACKET');
    await writeSyntheticPacket(malformedSums);
    await atomicWriteFile(resolve(malformedSums, 'SHA256SUMS.txt'), 'not a sha binding\n');
    await assert.rejects(
      () => scanLocalDatasetPacket(malformedSums, resolve(root, 'local-d')),
      packetErrorCode('SHA256SUMS_PARSE_FAIL'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 rejects missing tracked files, untracked extras, promotion denial, and mixed dataset bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-inventory-'));
  try {
    const missingTracked = resolve(root, 'missing-tracked', 'DATA_PACKET');
    await writeSyntheticPacket(missingTracked);
    await atomicWriteFile(resolve(missingTracked, 'audit', 'optional.txt'), 'tracked optional\n');
    await buildSha256Sums(missingTracked);
    await rm(resolve(missingTracked, 'audit', 'optional.txt'));
    await assert.rejects(
      () => scanLocalDatasetPacket(missingTracked, resolve(root, 'local-a')),
      packetErrorCode('PACKET_INVENTORY_MISMATCH'),
    );

    const extra = resolve(root, 'extra', 'DATA_PACKET');
    await writeSyntheticPacket(extra);
    await atomicWriteFile(resolve(extra, 'audit', 'untracked.txt'), 'untracked\n');
    await assert.rejects(
      () => scanLocalDatasetPacket(extra, resolve(root, 'local-b')),
      packetErrorCode('PACKET_INVENTORY_MISMATCH'),
    );

    const promotion = resolve(root, 'promotion', 'DATA_PACKET');
    await writeSyntheticPacket(promotion);
    await mutateJson(resolve(promotion, 'manifest.json'), value => { value.canonical_promotion_allowed = false; });
    await buildSha256Sums(promotion);
    await assert.rejects(
      () => scanLocalDatasetPacket(promotion, resolve(root, 'local-c')),
      packetErrorCode('CANONICAL_PROMOTION_NOT_ALLOWED'),
    );

    const mixed = resolve(root, 'mixed', 'DATA_PACKET');
    await writeSyntheticPacket(mixed);
    await mutateJson(resolve(mixed, 'numba', 'dataset.json'), value => {
      value.dataset_id = `HDH_DATASET_V1_${'f'.repeat(64)}`;
    });
    await buildSha256Sums(mixed);
    await assert.rejects(
      () => scanLocalDatasetPacket(mixed, resolve(root, 'local-d')),
      packetErrorCode('DATASET_BINDING_MISMATCH'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 rejects absolute/drive-qualified and symlink ZIP entries before extraction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-zipunsafe-'));
  try {
    for (const name of ['/escape.txt', 'C:/escape.txt']) {
      const zipPath = resolve(root, name.startsWith('/') ? 'absolute.zip' : 'drive.zip');
      await atomicWriteFile(zipPath, storedZip([
        { name, content: utf8('escape') },
        { name: 'DATA_PACKET/manifest.json', content: utf8('{}\n') },
      ]));
      await assert.rejects(
        () => scanLocalDatasetPacket(zipPath, resolve(root, 'local')),
        packetErrorCode('UNSAFE_ARCHIVE_ENTRY'),
      );
    }

    const symlinkZip = resolve(root, 'symlink.zip');
    await atomicWriteFile(symlinkZip, storedZip([
      { name: 'DATA_PACKET/link', content: utf8('../outside'), unixMode: 0o120777 },
      { name: 'DATA_PACKET/manifest.json', content: utf8('{}\n') },
    ]));
    await assert.rejects(
      () => scanLocalDatasetPacket(symlinkZip, resolve(root, 'local-symlink')),
      packetErrorCode('UNSAFE_ARCHIVE_ENTRY'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 rejects directory symlink escape without following it', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-symlink-'));
  try {
    const packet = resolve(root, 'DATA_PACKET');
    const outside = resolve(root, 'outside.txt');
    await writeSyntheticPacket(packet);
    await atomicWriteFile(outside, 'outside\n');
    await symlink(outside, resolve(packet, 'audit', 'escape-link'));
    await assert.rejects(
      () => scanLocalDatasetPacket(packet, resolve(root, 'local')),
      packetErrorCode('WINDOWS_PATH_UNSAFE'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 never executes executable-looking Packet content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-noexec-'));
  try {
    const packet = resolve(root, 'DATA_PACKET');
    const marker = resolve(root, 'SHOULD_NOT_EXIST');
    await writeSyntheticPacket(packet);
    const readme = resolve(packet, 'README.md');
    await atomicWriteFile(readme, `#!/bin/sh\nprintf pwned > ${JSON.stringify(marker)}\n`);
    if (process.platform !== 'win32') await chmod(readme, 0o755);
    await buildSha256Sums(packet);
    const scan = await scanLocalDatasetPacket(packet, resolve(root, 'local'));
    assert.equal(scan.local_import_status, 'VALIDATED');
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 interrupted materialization exposes no final Packet and cleans tool-owned staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-interrupt-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await assert.rejects(
      () => importLocalDatasetPacket(source, localRoot, {
        afterMaterialize: async () => { throw new Error('synthetic materialization interruption'); },
      }),
      /synthetic materialization interruption/,
    );
    await assert.rejects(stat(resolve(localRoot, 'datasets', DATASET_ID)), { code: 'ENOENT' });
    await assertStagingEmpty(localRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 registry commit failure after filesystem publish retains valid orphan and never reports registration PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-registryfail-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await assert.rejects(
      () => importAndRegisterLocalDatasetPacket(source, localRoot, {
        beforeCommit: () => { throw new Error('synthetic registry commit failure'); },
      }),
      registryErrorCode('REGISTRY_TRANSACTION_FAIL'),
    );
    const finalPacket = resolve(localRoot, 'datasets', DATASET_ID, 'DATA_PACKET');
    const scan = await scanLocalDatasetPacket(finalPacket, localRoot);
    assert.equal(scan.dataset_id, DATASET_ID);
    assert.equal((await listRegisteredDatasets(localRoot)).datasets.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.6 disk-space gate is explicit and runs before staging/local-root materialization', async () => {
  const source = await readSource('src/local/installer.ts');
  assert.match(source, /'INSUFFICIENT_DISK_SPACE'/);
  assert.match(source, /statfs\(anchor\)/);
  assert.match(source, /available < requiredBytes/);
  const freeSpaceGate = source.indexOf('await requireFreeSpace(root, candidate.packet_total_bytes);');
  const localRootCreate = source.indexOf('await mkdir(root, { recursive: true });', freeSpaceGate);
  assert.ok(freeSpaceGate >= 0, 'free-space gate call must exist');
  assert.ok(localRootCreate > freeSpaceGate, 'free-space gate must run before local root/staging creation');
});

test('P5.6 Phase 5 runtime is offline/local-first and has no execution/network primitives', async () => {
  const runtimeFiles = [
    'src/local/packet-verifier.ts',
    'src/local/installer.ts',
    'src/local/registry.ts',
    'src/local/handoff.ts',
    'src/local-cli.ts',
    'src/local-entry.ts',
  ];
  const forbidden = [
    "'node:http'", '"node:http"',
    "'node:https'", '"node:https"',
    "'node:net'", '"node:net"',
    "'node:tls'", '"node:tls"',
    "'node:dns'", '"node:dns"',
    'child_process',
  ];
  for (const file of runtimeFiles) {
    const source = await readSource(file);
    for (const token of forbidden) assert.equal(source.includes(token), false, `${file} contains forbidden runtime token ${token}`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} must not use fetch`);
    assert.doesNotMatch(
      source,
      /(^|[^\w.])(?:execFileSync|execFile|exec|spawnSync|spawn|fork)\s*\(/m,
      `${file} must not execute Packet/process content`,
    );
  }
});

test('P5.6 public tree contains no market payload files and Phase 5 runtime/skill contains no secret or personal-path literals', async () => {
  const roots = ['src', 'skills', 'docs', 'examples', 'config', 'mt5'];
  const marketPayloads: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(resolve(current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (/\.(?:parquet|bi5)$/i.test(entry.name) || /\.ticks\.csv$/i.test(entry.name)) marketPayloads.push(child);
    }
  }
  for (const root of roots) await walk(root);
  assert.deepEqual(marketPayloads, []);

  const inspectFiles = [
    'src/local/packet-verifier.ts',
    'src/local/installer.ts',
    'src/local/registry.ts',
    'src/local/handoff.ts',
    'src/local-cli.ts',
    'src/local-entry.ts',
    'skills/hdh-local-import/SKILL.md',
  ];
  const secretPatterns = [
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /sk-[A-Za-z0-9_-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  const personalPathPatterns = [
    /[A-Za-z]:\\Users\\[^<\\\s]+\\/,
    /\/Users\/[^<\/\s]+\//,
    /\/home\/[^<\/\s]+\//,
  ];
  for (const file of inspectFiles) {
    const source = await readSource(file);
    for (const pattern of secretPatterns) assert.doesNotMatch(source, pattern, `${file} contains secret-like literal`);
    for (const pattern of personalPathPatterns) assert.doesNotMatch(source, pattern, `${file} contains personal absolute-path literal`);
  }
});

test('P5.6 Unicode/space local paths work cross-platform while Packet logical paths remain forward-slash stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p56-paths-'));
  try {
    const source = resolve(root, '入力 データ 日本語', 'DATA_PACKET');
    const localRoot = resolve(root, 'ローカル HDH データ with spaces');
    await writeSyntheticPacket(source);
    const imported = await importAndRegisterLocalDatasetPacket(source, localRoot);
    const handoff = await buildLocalConsumerHandoff(localRoot, DATASET_ID);
    assert.equal(imported.local_import_status, 'IMPORTED');
    assert.equal(handoff.numba.canonical_parquet_files[0]!.packet_relative_path, CANONICAL_PATH);
    assert.equal(handoff.mt5.tick_files[0]!.packet_relative_path, MT5_PATH);
    assert.equal(handoff.numba.canonical_parquet_files[0]!.packet_relative_path.includes('\\'), false);
    assert.equal(handoff.mt5.tick_files[0]!.packet_relative_path.includes('\\'), false);
    assert.equal((await readFile(handoff.numba.dataset_json_path, 'utf8')).includes(CANONICAL_PATH), true);
    assert.equal((await readFile(handoff.mt5.symbol_contract_path, 'utf8')).includes(MT5_PATH), true);
    if (process.platform === 'win32') {
      assert.equal(handoff.local_packet_path.includes('\\'), true);
      assert.equal(handoff.numba.canonical_parquet_files[0]!.local_path.includes('\\'), true);
      assert.equal(handoff.mt5.tick_files[0]!.local_path.includes('\\'), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

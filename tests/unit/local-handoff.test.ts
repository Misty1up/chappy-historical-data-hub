import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from '../../src/core/atomic-write.js';
import { sha256File } from '../../src/core/hash.js';
import { buildSha256Sums } from '../../src/core/run-evidence.js';
import { runLocalCommand } from '../../src/local-cli.js';
import {
  LOCAL_HANDOFF_SCHEMA_VERSION,
  buildLocalConsumerHandoff,
} from '../../src/local/handoff.js';
import { importLocalDatasetPacket } from '../../src/local/installer.js';
import {
  LocalRegistryError,
  importAndRegisterLocalDatasetPacket,
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
  await atomicWriteFile(resolve(packetRoot, 'README.md'), '# Synthetic P5.4 Dataset Packet\n');
  await buildSha256Sums(packetRoot);
}

function registryErrorCode(code: string) {
  return (cause: unknown): boolean => cause instanceof LocalRegistryError && cause.code === code;
}

function assertInside(root: string, path: string): void {
  const back = relative(resolve(root), resolve(path));
  assert.notEqual(back, '');
  assert.equal(back === '..' || back.startsWith('../') || back.startsWith('..\\'), false);
}

async function packetFingerprint(packetRoot: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result[relative(packetRoot, absolute).replaceAll('\\', '/')] = await sha256File(absolute);
      else assert.fail(`Unexpected fixture filesystem entry: ${absolute}`);
    }
  }
  await walk(packetRoot);
  return result;
}

test('P5.4 handoff exposes only verified Packet-bound Numba/MT5 references and performs no mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p54-handoff-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local handoff 日本語');
    await writeSyntheticPacket(source);
    const imported = await importAndRegisterLocalDatasetPacket(source, localRoot);
    const packetRoot = imported.final_packet_path;
    const packetBefore = await packetFingerprint(packetRoot);
    const registryBefore = await sha256File(resolve(localRoot, 'registry', 'hdh_registry.sqlite'));

    const result = await buildLocalConsumerHandoff(localRoot, DATASET_ID);

    assert.equal(result.handoff_schema_version, LOCAL_HANDOFF_SCHEMA_VERSION);
    assert.equal(result.handoff_status, 'PASS');
    assert.equal(result.dataset_id, DATASET_ID);
    assert.equal(result.local_packet_path, packetRoot);
    assert.equal(result.registry.registry_verify_status, 'PASS');
    assert.equal(result.registry.packet_revalidation_status, 'PASS');
    assert.equal(result.authority.source_hash_root, SOURCE_HASH_ROOT);
    assert.equal(result.authority.canonical_logical_hash_root, result.registry.dataset.canonical_logical_hash_root);
    assert.equal(result.authority.parquet_file_hash_root, result.registry.dataset.parquet_file_hash_root);
    assert.equal(result.authority.mt5_derivative_hash_root, result.registry.dataset.mt5_derivative_hash_root);

    assert.equal(result.numba.dataset_json_path, resolve(packetRoot, 'numba', 'dataset.json'));
    assert.deepEqual(result.numba.canonical_parquet_files.map(item => item.packet_relative_path), [CANONICAL_PATH]);
    assert.equal(result.numba.canonical_parquet_files[0]!.local_path, resolve(packetRoot, CANONICAL_PATH));
    assert.equal(result.mt5.symbol_contract_path, resolve(packetRoot, 'mt5', 'symbol_contract.json'));
    assert.equal(result.mt5.tick_root_path, resolve(packetRoot, 'mt5', 'ticks'));
    assert.equal(result.mt5.tick_symbol_path, resolve(packetRoot, 'mt5', 'ticks', 'EURUSD'));
    assert.deepEqual(result.mt5.tick_files.map(item => item.packet_relative_path), [MT5_PATH]);
    assert.equal(result.mt5.tick_files[0]!.local_path, resolve(packetRoot, MT5_PATH));

    for (const path of [
      result.numba.dataset_json_path,
      ...result.numba.canonical_parquet_files.map(item => item.local_path),
      result.mt5.symbol_contract_path,
      result.mt5.tick_root_path,
      result.mt5.tick_symbol_path,
      ...result.mt5.tick_files.map(item => item.local_path),
    ]) assertInside(packetRoot, path);

    assert.equal(result.packet_mutation_performed, false);
    assert.equal(result.registry_mutation_performed, false);
    assert.equal(result.terminal_mt5_mutation_performed, false);
    assert.equal(result.strategy_evaluation_performed, false);
    assert.equal(result.numba_mt5_parity_declared, false);
    assert.deepEqual(await packetFingerprint(packetRoot), packetBefore);
    assert.equal(await sha256File(resolve(localRoot, 'registry', 'hdh_registry.sqlite')), registryBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.4 refuses an unregistered valid P5.2 orphan instead of guessing a handoff path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p54-orphan-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const p52 = await importLocalDatasetPacket(source, localRoot);
    assert.equal(p52.local_import_status, 'IMPORTED');

    await assert.rejects(
      () => buildLocalConsumerHandoff(localRoot, DATASET_ID),
      registryErrorCode('DATASET_NOT_REGISTERED'),
    );
    assert.equal(await readFile(resolve(p52.final_packet_path, CANONICAL_PATH), 'utf8'), 'synthetic-canonical-payload\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.4 refuses a corrupted registered Packet and never repairs consumer files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p54-corrupt-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const imported = await importAndRegisterLocalDatasetPacket(source, localRoot);
    const canonical = resolve(imported.final_packet_path, CANONICAL_PATH);
    await atomicWriteFile(canonical, 'tampered-before-handoff\n');

    await assert.rejects(
      () => buildLocalConsumerHandoff(localRoot, DATASET_ID),
      registryErrorCode('LOCAL_REGISTRY_INCONSISTENT'),
    );
    assert.equal(await readFile(canonical, 'utf8'), 'tampered-before-handoff\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.4 refuses tampered Numba binding metadata instead of emitting consumer references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p54-binding-'));
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    const imported = await importAndRegisterLocalDatasetPacket(source, localRoot);
    const datasetJson = resolve(imported.final_packet_path, 'numba', 'dataset.json');
    const parsed = JSON.parse(await readFile(datasetJson, 'utf8')) as Record<string, unknown>;
    parsed.dataset_id = `HDH_DATASET_V1_${'9'.repeat(64)}`;
    await atomicWriteFile(datasetJson, `${JSON.stringify(parsed, null, 2)}\n`);

    await assert.rejects(
      () => buildLocalConsumerHandoff(localRoot, DATASET_ID),
      registryErrorCode('LOCAL_REGISTRY_INCONSISTENT'),
    );
    assert.equal((JSON.parse(await readFile(datasetJson, 'utf8')) as Record<string, unknown>).dataset_id, parsed.dataset_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P5.4 CLI handoff returns the same read-only accepted consumer surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p54-cli-'));
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  try {
    const source = resolve(root, 'source', 'DATA_PACKET');
    const localRoot = resolve(root, 'local');
    await writeSyntheticPacket(source);
    await importAndRegisterLocalDatasetPacket(source, localRoot);
    const packetBefore = await sha256File(resolve(localRoot, 'datasets', DATASET_ID, 'DATA_PACKET', 'SHA256SUMS.txt'));
    const registryBefore = await sha256File(resolve(localRoot, 'registry', 'hdh_registry.sqlite'));
    let output = '';
    console.log = (...args: unknown[]) => { output += `${args.map(String).join(' ')}\n`; };
    process.exitCode = undefined;

    await runLocalCommand(['handoff', '--dataset-id', DATASET_ID, '--root', localRoot]);

    const parsed = JSON.parse(output) as {
      handoff_schema_version: string;
      handoff_status: string;
      dataset_id: string;
      terminal_mt5_mutation_performed: boolean;
      numba_mt5_parity_declared: boolean;
    };
    assert.equal(parsed.handoff_schema_version, LOCAL_HANDOFF_SCHEMA_VERSION);
    assert.equal(parsed.handoff_status, 'PASS');
    assert.equal(parsed.dataset_id, DATASET_ID);
    assert.equal(parsed.terminal_mt5_mutation_performed, false);
    assert.equal(parsed.numba_mt5_parity_declared, false);
    assert.equal(process.exitCode, undefined);
    assert.equal(await sha256File(resolve(localRoot, 'datasets', DATASET_ID, 'DATA_PACKET', 'SHA256SUMS.txt')), packetBefore);
    assert.equal(await sha256File(resolve(localRoot, 'registry', 'hdh_registry.sqlite')), registryBefore);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    await rm(root, { recursive: true, force: true });
  }
});

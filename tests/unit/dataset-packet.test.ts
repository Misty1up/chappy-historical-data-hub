import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { snapshotPathForDay } from '../../src/core/acquire-day.js';
import { atomicWriteFile } from '../../src/core/atomic-write.js';
import { sha256File, sha256Text } from '../../src/core/hash.js';
import { writeSourceSnapshot } from '../../src/core/source-snapshot.js';
import { convertSourceSnapshotToCanonicalDay } from '../../src/canonical/convert.js';
import { deriveMt5TickDerivativeDay } from '../../src/mt5/derive.js';
import { writeMt5DerivativeDay } from '../../src/mt5/write.js';
import { writeCanonicalParquetDay, canonicalParquetPathForDay } from '../../src/parquet/write.js';
import { buildDatasetPacket } from '../../src/packet/build.js';
import {
  CANONICAL_SCHEMA_VERSION,
  datasetIdFor,
  hashEntriesRoot,
  sameTimestampGroupCount,
  serializeDatasetIdentity,
} from '../../src/packet/contract.js';
import type { SourceTick, SymbolRegistryEntry } from '../../src/types/contracts.js';

const symbol: SymbolRegistryEntry = {
  canonical_symbol: 'EURUSD',
  enabled: true,
  source_adapter_id: 'dukascopy-node',
  source_instrument: 'eurusd',
  source_api_code: 'eurusd',
  source_api_code_provenance: 'unit-test',
  source_feed_type: 'tick',
  source_start_hint_utc: '2000-01-01T00:00:00.000Z',
  source_start_hint_provenance: 'unit-test',
  source_start_hint_status: 'VERIFIED_BY_FETCH',
  precision_status: 'VERIFIED',
  price_digits: 5,
  price_scale: 100000,
};

const identityInput = {
  canonical_schema_version: CANONICAL_SCHEMA_VERSION,
  symbol: 'EURUSD',
  requested_from_utc: '2026-01-05T00:00:00.000Z',
  requested_to_utc: '2026-01-06T00:00:00.000Z',
  source_hash_root: 'a'.repeat(64),
  precision_evidence_sha256: 'b'.repeat(64),
  generator_git_commit: 'c'.repeat(40),
};

test('dataset identity serialization is fixed-order, LF terminated and deterministic', () => {
  const expected = [
    'HDH_DATASET_ID_V1',
    'canonical_schema_version=0.1',
    'symbol=EURUSD',
    'requested_from_utc=2026-01-05T00:00:00.000Z',
    'requested_to_utc=2026-01-06T00:00:00.000Z',
    `source_hash_root=${'a'.repeat(64)}`,
    `precision_evidence_sha256=${'b'.repeat(64)}`,
    `generator_git_commit=${'c'.repeat(40)}`,
    '',
  ].join('\n');
  assert.equal(serializeDatasetIdentity(identityInput), expected);
  assert.equal(datasetIdFor(identityInput), datasetIdFor({ ...identityInput }));
  assert.notEqual(datasetIdFor(identityInput), datasetIdFor({ ...identityInput, precision_evidence_sha256: 'd'.repeat(64) }));
});

test('hash roots sort keys deterministically and reject duplicate keys', () => {
  const a = '1'.repeat(64);
  const b = '2'.repeat(64);
  assert.equal(
    hashEntriesRoot([{ key: 'b', sha256: b }, { key: 'a', sha256: a }]),
    sha256Text(`a  ${a}\nb  ${b}\n`),
  );
  assert.throws(() => hashEntriesRoot([{ key: 'a', sha256: a }, { key: 'a', sha256: b }]), /Duplicate hash root key/);
});

test('same timestamp groups are counted without merging rows', () => {
  assert.equal(sameTimestampGroupCount([
    { timestamp_msc: 1n },
    { timestamp_msc: 1n },
    { timestamp_msc: 1n },
    { timestamp_msc: 2n },
    { timestamp_msc: 3n },
    { timestamp_msc: 3n },
  ]), 2);
});

test('Dataset Packet binds frozen Source, Canonical Parquet and MT5 derivative to one dataset_id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-packet-'));
  try {
    const sourceRunRoot = resolve(root, 'source');
    const canonicalRoot = resolve(root, 'parquet');
    const mt5Root = resolve(root, 'mt5-derivative');
    const packetA = resolve(root, 'packet-a');
    const packetB = resolve(root, 'packet-b');
    const dateUtc = '2026-01-05';
    const ticks: SourceTick[] = [
      { timestamp_msc: 1767571200001n, bid: 1.1, ask: 1.10002, bid_volume: null, ask_volume: 1.25, source_seq: 0 },
      { timestamp_msc: 1767571200001n, bid: 1.1, ask: 1.10002, bid_volume: null, ask_volume: 1.25, source_seq: 1 },
      { timestamp_msc: 1767571200250n, bid: 1.09995, ask: 1.09999, bid_volume: 2.5, ask_volume: 0, source_seq: 2 },
    ];
    const snapshotPath = snapshotPathForDay(sourceRunRoot, symbol, dateUtc);
    await writeSourceSnapshot(snapshotPath, ticks);
    const snapshotSha = await sha256File(snapshotPath);
    const sourceRoot = hashEntriesRoot([{ key: dateUtc, sha256: snapshotSha }]);
    await mkdir(resolve(sourceRunRoot, 'integrity'), { recursive: true });
    const dailyAudit = {
      date_utc: dateUtc,
      requested_from_utc: '2026-01-05T00:00:00.000Z',
      requested_to_utc: '2026-01-06T00:00:00.000Z',
      status: 'PASS',
      tick_count: ticks.length,
      first_timestamp_msc: ticks[0]!.timestamp_msc.toString(),
      last_timestamp_msc: ticks.at(-1)!.timestamp_msc.toString(),
      exact_duplicate_count: 1,
      same_timestamp_pair_count: 1,
      out_of_range_count: 0,
      out_of_order_count: 0,
      invalid_bid_count: 0,
      invalid_ask_count: 0,
      invalid_price_count: 0,
      negative_spread_count: 0,
      null_bid_volume_count: 2,
      null_ask_volume_count: 0,
      snapshot_path: 'source_ticks/dukascopy-node/EURUSD/2026/01/2026-01-05.jsonl.gz',
      snapshot_sha256: snapshotSha,
      failure_class: null,
      note: null,
    };
    await atomicWriteFile(resolve(sourceRunRoot, 'integrity', 'daily_audit.jsonl'), `${JSON.stringify(dailyAudit)}\n`);
    await atomicWriteFile(resolve(sourceRunRoot, 'manifest.json'), `${JSON.stringify({
      schema_version: '0.1.0',
      run_id: 'HDH_EURUSD_20260105_20260106',
      symbol: 'EURUSD',
      requested_from_utc: '2026-01-05T00:00:00.000Z',
      requested_to_utc: '2026-01-06T00:00:00.000Z',
      daily_source_hashes: [{ date_utc: dateUtc, sha256: snapshotSha }],
      source_hash_root: sourceRoot,
      integrity_status: 'PASS',
      phase_1_source_snapshot_only: true,
    }, null, 2)}\n`);

    const precisionPath = resolve(root, 'precision_evidence.json');
    await atomicWriteFile(precisionPath, `${JSON.stringify({
      symbol: 'EURUSD',
      candidate_price_digits: 5,
      candidate_price_scale: 100000,
      bid_scaled_conversion_fail_count: 0,
      ask_scaled_conversion_fail_count: 0,
      exact_lattice_pass: true,
      precision_status: 'VERIFIED',
    }, null, 2)}\n`);

    const canonical = await convertSourceSnapshotToCanonicalDay({
      symbol,
      dateUtc,
      sourceSnapshotPath: snapshotPath,
      expectedSourceSnapshotSha256: snapshotSha,
      expectedSourceRowCount: ticks.length,
    });
    await writeCanonicalParquetDay(canonical, canonicalParquetPathForDay(canonicalRoot, 'EURUSD', dateUtc));
    await writeMt5DerivativeDay(deriveMt5TickDerivativeDay(canonical), mt5Root);

    const common = {
      symbol,
      sourceRunRoot,
      precisionEvidencePath: precisionPath,
      canonicalRoot,
      mt5Root,
      generatorGitCommit: 'd'.repeat(40),
    };
    const first = await buildDatasetPacket({ ...common, outRoot: packetA, generatedAtUtc: '2026-08-30T00:00:00.000Z' });
    const second = await buildDatasetPacket({ ...common, outRoot: packetB, generatedAtUtc: '2026-08-30T01:00:00.000Z' });
    assert.equal(first.manifest.dataset_id, second.manifest.dataset_id);
    assert.equal(first.manifest.tick_count_total, ticks.length);
    assert.equal(first.manifest.canonical_file_count, 1);
    assert.equal(first.manifest.canonical_promotion_allowed, true);
    assert.ok(first.sha256sums_checked_files >= 8);

    const numba = JSON.parse(await readFile(resolve(packetA, 'numba', 'dataset.json'), 'utf8')) as Record<string, unknown>;
    const mt5 = JSON.parse(await readFile(resolve(packetA, 'mt5', 'symbol_contract.json'), 'utf8')) as Record<string, unknown>;
    const integrity = JSON.parse(await readFile(resolve(packetA, 'audit', 'integrity_report.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(numba.dataset_id, first.manifest.dataset_id);
    assert.equal(mt5.dataset_id, first.manifest.dataset_id);
    assert.equal(integrity.dataset_id, first.manifest.dataset_id);
    assert.equal(numba.canonical_logical_hash_root, mt5.canonical_logical_hash_root);
    assert.equal(integrity.integrity_status, 'PASS');

    const canonicalAuditText = await readFile(resolve(packetA, 'audit', 'canonical_daily_audit.jsonl'), 'utf8');
    const canonicalAudit = JSON.parse(canonicalAuditText.trim()) as Record<string, unknown>;
    assert.equal(canonicalAudit.same_timestamp_group_count, 1);
    assert.equal(canonicalAudit.source_tick_count, ticks.length);
    assert.equal(canonicalAudit.canonical_tick_count, ticks.length);
    assert.equal(canonicalAudit.status, 'PASS');
    assert.match(await readFile(resolve(packetA, 'SHA256SUMS.txt'), 'utf8'), /manifest\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

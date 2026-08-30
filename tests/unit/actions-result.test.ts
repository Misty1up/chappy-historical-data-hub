import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPassActionResult, type Phase4QuickManifest } from '../../src/actions/result.js';
import type { DatasetPacketManifest } from '../../src/packet/types.js';
import type { WebJobRequest } from '../../src/web/contract.js';

const baseRequest = {
  request_schema_version: '0.1',
  symbol: 'EURUSD',
  requested_from_utc: '2026-01-05T00:00:00.000Z',
  requested_to_utc: '2026-01-06T00:00:00.000Z',
  requested_output: 'DATASET_PACKET',
  accepted_contract_version: 'HDH_PHASE2_ACCEPTED_V1',
} as const;

const packet: DatasetPacketManifest = {
  manifest_schema_version: '0.1.0',
  dataset_id: `HDH_DATASET_V1_${'a'.repeat(64)}`,
  canonical_schema_version: '0.1',
  generator_git_commit: 'b'.repeat(40),
  source_run_id: 'HDH_EURUSD_20260105_20260106',
  source_hash_root: '1'.repeat(64),
  symbol: 'EURUSD',
  requested_from_utc: '2026-01-05T00:00:00.000Z',
  requested_to_utc: '2026-01-06T00:00:00.000Z',
  tick_count_total: 123,
  canonical_file_count: 1,
  price_digits: 5,
  price_scale: 100000,
  precision_status: 'VERIFIED',
  precision_evidence_sha256: '2'.repeat(64),
  canonical_logical_hash_root: '3'.repeat(64),
  parquet_file_hash_root: '4'.repeat(64),
  mt5_derivative_hash_root: '5'.repeat(64),
  integrity_status: 'PASS',
  canonical_promotion_allowed: true,
  generated_at_utc: '2026-08-30T00:00:00.000Z',
};

const context = {
  workflow_run_id: '123',
  workflow_run_attempt: '1',
  repository_commit: 'c'.repeat(40),
  started_at_utc: '2026-08-30T01:00:00.000Z',
  completed_at_utc: '2026-08-30T01:01:00.000Z',
};

test('MT5_PARITY_MASTER result copies packet authority and explicitly limits parity scope', () => {
  const request: WebJobRequest = { ...baseRequest, mode: 'MT5_PARITY_MASTER' };
  const result = buildPassActionResult(request, packet, context);
  assert.equal(result.status, 'PASS');
  assert.equal(result.dataset_id, packet.dataset_id);
  assert.equal(result.source_hash_root, packet.source_hash_root);
  assert.equal(result.canonical_logical_hash_root, packet.canonical_logical_hash_root);
  assert.equal(result.canonical_promotion_allowed, true);
  assert.equal(result.packet_artifact_reference, null);
  assert.deepEqual(result.mt5_parity_binding, {
    binding_status: 'PASS',
    parity_scope: 'PACKET_BINDING_ONLY',
    dataset_id: packet.dataset_id,
    source_hash_root: packet.source_hash_root,
    canonical_logical_hash_root: packet.canonical_logical_hash_root,
    mt5_derivative_hash_root: packet.mt5_derivative_hash_root,
    terminal_mt5_parity_executed: false,
  });
});

test('RESEARCH_MASTER uses the same packet authority without claiming terminal parity', () => {
  const request: WebJobRequest = { ...baseRequest, mode: 'RESEARCH_MASTER' };
  const result = buildPassActionResult(request, packet, context);
  assert.equal(result.dataset_id, packet.dataset_id);
  assert.equal(result.mt5_parity_binding, undefined);
});

test('result binding accepts semantically identical UTC timestamps with Z versus .000Z', () => {
  const request: WebJobRequest = {
    ...baseRequest,
    mode: 'RESEARCH_MASTER',
    requested_from_utc: '2026-01-05T00:00:00Z',
    requested_to_utc: '2026-01-06T00:00:00Z',
  };
  const result = buildPassActionResult(request, packet, context);
  assert.equal(result.status, 'PASS');
  assert.equal(result.request.requested_from_utc, '2026-01-05T00:00:00Z');
  assert.equal(result.request.requested_to_utc, '2026-01-06T00:00:00Z');
  assert.equal(result.requested_from_utc, packet.requested_from_utc);
  assert.equal(result.requested_to_utc, packet.requested_to_utc);
});

test('result binding still rejects an actual UTC instant mismatch', () => {
  const request: WebJobRequest = { ...baseRequest, mode: 'RESEARCH_MASTER' };
  assert.throws(
    () => buildPassActionResult(request, { ...packet, requested_from_utc: '2026-01-05T00:00:00.001Z' }, context),
    /requested_from_utc mismatch/,
  );
  assert.throws(
    () => buildPassActionResult(request, { ...packet, requested_to_utc: '2026-01-06T00:00:01.000Z' }, context),
    /requested_to_utc mismatch/,
  );
});

test('result binding rejects request/manifest mismatch instead of reinterpreting authority', () => {
  const request: WebJobRequest = { ...baseRequest, mode: 'RESEARCH_MASTER' };
  assert.throws(() => buildPassActionResult(request, { ...packet, source_hash_root: 'not-a-hash' }, context), /source_hash_root/);
  assert.throws(() => buildPassActionResult(request, { ...packet, symbol: 'XAUUSD' }, context), /symbol mismatch/);
});

test('QUICK_DOWNLOAD remains non-canonical and has no dataset identity', () => {
  const request: WebJobRequest = { ...baseRequest, mode: 'QUICK_DOWNLOAD', requested_output: 'QUICK_EXPORT' };
  const quick: Phase4QuickManifest = {
    symbol: 'EURUSD',
    requested_from_utc: request.requested_from_utc,
    requested_to_utc: request.requested_to_utc,
    tick_count_total: 50,
    source_hash_root: '6'.repeat(64),
    integrity_status: 'PASS',
    canonical_promotion_allowed: false,
  };
  const result = buildPassActionResult(request, quick, context);
  assert.equal(result.dataset_id, null);
  assert.equal(result.canonical_logical_hash_root, null);
  assert.equal(result.canonical_promotion_allowed, false);
});

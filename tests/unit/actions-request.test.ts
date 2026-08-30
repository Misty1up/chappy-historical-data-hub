import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidateActionRequestJson } from '../../src/actions/request.js';
import type { WebSymbolContract } from '../../src/web/contract.js';

const symbols: WebSymbolContract[] = [
  { canonical_symbol: 'EURUSD', enabled: true, precision_status: 'VERIFIED' },
  { canonical_symbol: 'XAUUSD', enabled: true, precision_status: 'VERIFIED' },
  { canonical_symbol: 'TESTUNVERIFIED', enabled: true, precision_status: 'UNVERIFIED' }
];

const validRequest = {
  request_schema_version: '0.1',
  symbol: 'EURUSD',
  requested_from_utc: '2026-01-05T00:00:00.000Z',
  requested_to_utc: '2026-01-06T00:00:00.000Z',
  mode: 'RESEARCH_MASTER',
  requested_output: 'DATASET_PACKET',
  accepted_contract_version: 'HDH_PHASE2_ACCEPTED_V1'
};

test('actions request adapter accepts an exact Phase 3 request and normalizes deterministically', () => {
  const result = parseAndValidateActionRequestJson(JSON.stringify(validRequest), symbols);
  assert.equal(result.ok, true, result.errors.join(', '));
  assert.ok(result.request);
  assert.equal(result.request.symbol, 'EURUSD');
  assert.equal(result.request.requested_output, 'DATASET_PACKET');
  assert.equal(result.serialized_request, JSON.stringify(result.request, null, 2) + '\n');
});

test('actions request adapter rejects malformed and authority-injecting request JSON', () => {
  assert.equal(parseAndValidateActionRequestJson('{', symbols).ok, false);
  assert.equal(parseAndValidateActionRequestJson('[]', symbols).ok, false);

  const injected = {
    ...validRequest,
    dataset_id: 'FORGED',
    source_hash_root: '0'.repeat(64),
    canonical_logical_hash_root: '1'.repeat(64)
  };
  const result = parseAndValidateActionRequestJson(JSON.stringify(injected), symbols);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unexpected fields/);
});

test('actions request adapter rejects contract version, mode/output and registry violations', () => {
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({ ...validRequest, request_schema_version: '9.9' }), symbols).ok, false);
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({ ...validRequest, accepted_contract_version: 'OTHER' }), symbols).ok, false);
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({ ...validRequest, mode: 'NOPE' }), symbols).ok, false);
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({ ...validRequest, requested_output: 'QUICK_EXPORT' }), symbols).ok, false);
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({ ...validRequest, symbol: 'GBPJPY' }), symbols).ok, false);
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({ ...validRequest, symbol: 'TESTUNVERIFIED', mode: 'MT5_PARITY_MASTER' }), symbols).ok, false);
});

test('actions request adapter rejects non-UTC and invalid ranges server-side', () => {
  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({
    ...validRequest,
    requested_from_utc: '2026-01-05T09:00:00+09:00',
    requested_to_utc: '2026-01-06T09:00:00+09:00'
  }), symbols).ok, false);

  assert.equal(parseAndValidateActionRequestJson(JSON.stringify({
    ...validRequest,
    requested_from_utc: '2026-01-06T00:00:00.000Z',
    requested_to_utc: '2026-01-05T00:00:00.000Z'
  }), symbols).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeWebJobRequest, validateWebJobDraft, type WebSymbolContract } from '../../src/web/contract.js';

const symbols: WebSymbolContract[] = [
  { canonical_symbol: 'EURUSD', enabled: true, precision_status: 'VERIFIED' },
  { canonical_symbol: 'XAUUSD', enabled: true, precision_status: 'VERIFIED' },
  { canonical_symbol: 'TESTUNVERIFIED', enabled: true, precision_status: 'UNVERIFIED' }
];

test('web request contract validates authority-safe requests and rejects invalid inputs', () => {
  const valid = validateWebJobDraft({
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    mode: 'RESEARCH_MASTER'
  }, symbols);
  assert.equal(valid.ok, true, valid.errors.join(', '));
  assert.ok(valid.request);
  assert.equal('dataset_id' in valid.request, false);
  assert.equal('source_hash_root' in valid.request, false);
  assert.equal('canonical_logical_hash_root' in valid.request, false);
  assert.equal(serializeWebJobRequest(valid.request), serializeWebJobRequest(valid.request));

  assert.equal(validateWebJobDraft({
    symbol: 'GBPJPY', requested_from_utc: '2026-01-05T00:00:00.000Z', requested_to_utc: '2026-01-06T00:00:00.000Z', mode: 'QUICK_DOWNLOAD'
  }, symbols).ok, false);

  assert.equal(validateWebJobDraft({
    symbol: 'EURUSD', requested_from_utc: '2026-01-06T00:00:00.000Z', requested_to_utc: '2026-01-05T00:00:00.000Z', mode: 'RESEARCH_MASTER'
  }, symbols).ok, false);

  assert.equal(validateWebJobDraft({
    symbol: 'EURUSD', requested_from_utc: '2026-01-05T09:00:00+09:00', requested_to_utc: '2026-01-06T09:00:00+09:00', mode: 'RESEARCH_MASTER'
  }, symbols).ok, false);

  assert.equal(validateWebJobDraft({
    symbol: 'TESTUNVERIFIED', requested_from_utc: '2026-01-05T00:00:00.000Z', requested_to_utc: '2026-01-06T00:00:00.000Z', mode: 'MT5_PARITY_MASTER'
  }, symbols).ok, false);
});

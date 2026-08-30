import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebJobRequest } from '../../src/web/contract.js';
import { assertWebJobView, createSyntheticJobFixture, isSuccessfulWebJobView } from '../../src/web/status-result.js';

const request: WebJobRequest = {
  request_schema_version: '0.1',
  symbol: 'EURUSD',
  requested_from_utc: '2026-01-05T00:00:00.000Z',
  requested_to_utc: '2026-01-06T00:00:00.000Z',
  mode: 'RESEARCH_MASTER',
  requested_output: 'DATASET_PACKET',
  accepted_contract_version: 'HDH_PHASE2_ACCEPTED_V1'
};

test('synthetic status/result fixtures never promote browser data to Canonical authority', () => {
  const pass = createSyntheticJobFixture(request, 'PASS');
  assertWebJobView(pass);
  assert.equal(pass.status, 'PASS');
  assert.ok(pass.result);
  assert.equal(pass.result.is_fixture, true);
  assert.equal(pass.result.canonical_promotion_allowed, false);
  assert.equal(isSuccessfulWebJobView(pass), false, 'fixture PASS cannot become canonical success');
  assert.match(pass.result.packet_artifact_reference, /^fixture:\/\//);

  const hold = createSyntheticJobFixture(request, 'HOLD');
  assertWebJobView(hold);
  assert.equal(hold.status, 'HOLD');
  assert.equal(isSuccessfulWebJobView(hold), false);
  assert.equal(hold.result, undefined);

  const fail = createSyntheticJobFixture(request, 'FAIL');
  assertWebJobView(fail);
  assert.equal(fail.status, 'FAIL');
  assert.equal(isSuccessfulWebJobView(fail), false);
  assert.equal(fail.result, undefined);

  assert.throws(() => assertWebJobView({ status: 'PASS', detail: 'missing result' }), /requires result metadata/);
});

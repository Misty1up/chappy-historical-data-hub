import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase4ExecutionPlan } from '../../src/actions/execute.js';
import type { WebJobRequest } from '../../src/web/contract.js';

function request(mode: WebJobRequest['mode']): WebJobRequest {
  return {
    request_schema_version: '0.1',
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-07T00:00:00.000Z',
    mode,
    requested_output: mode === 'QUICK_DOWNLOAD' ? 'QUICK_EXPORT' : 'DATASET_PACKET',
    accepted_contract_version: 'HDH_PHASE2_ACCEPTED_V1'
  };
}

test('P4.3 QUICK plan uses accepted acquisition CLI only', () => {
  const plan = buildPhase4ExecutionPlan(request('QUICK_DOWNLOAD'));
  assert.deepEqual(plan.utcDays, ['2026-01-05', '2026-01-06']);
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0]![0], 'dist/src/cli.js');
  assert.equal(plan.commands[0]![1], 'acquire');
});

test('P4.3 RESEARCH plan composes accepted acquisition/precision/parquet/MT5-derivative/packet CLIs', () => {
  const plan = buildPhase4ExecutionPlan(request('RESEARCH_MASTER'));
  assert.equal(plan.commands.length, 7);
  assert.deepEqual(plan.commands.map(command => command[0]), [
    'dist/src/cli.js',
    'dist/src/precision-cli.js',
    'dist/src/parquet-cli.js',
    'dist/src/mt5-cli.js',
    'dist/src/parquet-cli.js',
    'dist/src/mt5-cli.js',
    'dist/src/packet-cli.js'
  ]);
  assert.match(plan.commands.at(-1)!.join(' '), /--precision-evidence .*precision_evidence\.json/);
});

test('P4.3 accepts equivalent strict UTC midnight form without explicit milliseconds', () => {
  const plan = buildPhase4ExecutionPlan({
    ...request('RESEARCH_MASTER'),
    requested_from_utc: '2026-01-06T00:00:00Z',
    requested_to_utc: '2026-01-07T00:00:00Z'
  });
  assert.deepEqual(plan.utcDays, ['2026-01-06']);
  assert.deepEqual(plan.commands[0]!.slice(0, 8), [
    'dist/src/cli.js', 'acquire', '--symbol', 'EURUSD', '--from', '2026-01-06', '--to', '2026-01-07'
  ]);
});

test('P4.3 preserves exact-range authority by refusing non-midnight requests instead of widening them', () => {
  assert.throws(() => buildPhase4ExecutionPlan({
    ...request('RESEARCH_MASTER'),
    requested_from_utc: '2026-01-05T12:00:00.000Z'
  }), /must be an exact UTC midnight/);
});

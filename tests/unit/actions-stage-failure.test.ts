import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Phase4CommandExecutionError,
  classifyPhase4ExecutionFailure,
  phase4ExecutionStageForCommand,
} from '../../src/actions/failure.js';

test('Phase 4 command stage is derived from the accepted CLI entrypoint', () => {
  assert.equal(phase4ExecutionStageForCommand(['dist/src/cli.js', 'acquire']), 'ACQUISITION');
  assert.equal(phase4ExecutionStageForCommand(['dist/src/precision-cli.js']), 'PRECISION');
  assert.equal(phase4ExecutionStageForCommand(['dist/src/parquet-cli.js']), 'CANONICAL');
  assert.equal(phase4ExecutionStageForCommand(['dist/src/mt5-cli.js']), 'MT5_DERIVATIVE');
  assert.equal(phase4ExecutionStageForCommand(['dist/src/packet-cli.js']), 'PACKET');
});

test('wrapped execFileSync precision failure classifies as PRECISION_NOT_VERIFIED without child stderr inspection', () => {
  const childProcessWrapper = new Error(
    'Command failed: node dist/src/precision-cli.js --symbol EURUSD --date 2026-01-06',
  );
  const wrapped = new Phase4CommandExecutionError(
    ['dist/src/precision-cli.js', '--symbol', 'EURUSD', '--date', '2026-01-06'],
    childProcessWrapper,
  );

  assert.equal(wrapped.stage, 'PRECISION');
  assert.equal(classifyPhase4ExecutionFailure(wrapped), 'PRECISION_NOT_VERIFIED');
});

test('stage-aware repair is scoped to precision command failures', () => {
  const wrapped = new Phase4CommandExecutionError(
    ['dist/src/parquet-cli.js', '--symbol', 'EURUSD', '--date', '2026-01-06'],
    new Error('Command failed: node dist/src/parquet-cli.js'),
  );
  assert.equal(classifyPhase4ExecutionFailure(wrapped), 'INTERNAL_ERROR');
});

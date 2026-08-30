import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/data-job.yml', 'utf8');

test('Phase 4 workflow skeleton keeps minimal permissions and explicit safety bounds', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /request_json:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /hdh-phase4-\$\{\{ needs\.preflight\.outputs\.request_key \}\}/);
});

test('Phase 4 workflow skeleton invokes shared server validation and does not execute market data yet', () => {
  assert.match(workflow, /node dist\/src\/actions\/request-cli\.js/);
  assert.match(workflow, /Market-data execution is intentionally not enabled until P4\.3/);
  assert.doesNotMatch(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /permissions:[\s\S]*contents: write/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/data-job.yml', 'utf8');

test('Phase 4 workflow keeps minimal permissions and explicit safety bounds', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /request_json:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /hdh-phase4-\$\{\{ needs\.preflight\.outputs\.request_key \}\}/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /permissions:[\s\S]*contents: write/);
});

test('P4.5 workflow measures before success upload and uses one-day temporary retention', () => {
  assert.match(workflow, /node dist\/src\/actions\/request-cli\.js/);
  assert.match(workflow, /node dist\/src\/actions\/execute-cli\.js/);
  assert.match(workflow, /node dist\/src\/actions\/transport-cli\.js prepare/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /retention-days: 1/);
  const measureIndex = workflow.indexOf('Measure and prepare bounded Artifact transport');
  const successUploadIndex = workflow.indexOf('Upload temporary success Artifact');
  assert.ok(measureIndex >= 0 && successUploadIndex > measureIndex, 'Artifact size preparation must occur before upload');
  assert.match(workflow, /steps\.transport\.outputs\.transport_status == 'PASS'/);
});

test('P4.5 workflow preserves FAIL/HOLD diagnostics and never promotes them as success Artifacts', () => {
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /node dist\/src\/actions\/transport-cli\.js upload-failed/);
  assert.match(workflow, /Upload compact FAIL or HOLD diagnostic/);
  assert.match(workflow, /Upload compact Artifact-upload failure diagnostic/);
  assert.match(workflow, /TRANSPORT_STATUS/);
  assert.match(workflow, /HOLD: bounded transport stopped safely/);
  assert.match(workflow, /FAIL: execution failed/);
});

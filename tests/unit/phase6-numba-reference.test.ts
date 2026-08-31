import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  phase6LayerEventCounts,
  phase6TraceRootSha256,
  validatePhase6Trace,
  type Phase6TraceEvent,
} from '../../src/parity/trace-contract.js';

test('P6_REFERENCE_PARITY_PROBE_V1 synthetic fixture conforms to P6.2 trace contract', () => {
  const path = resolve(process.cwd(), 'tests', 'fixtures', 'phase6-numba-reference-trace.json');
  const events = JSON.parse(readFileSync(path, 'utf8')) as Phase6TraceEvent[];
  validatePhase6Trace(events, 'NUMBA');
  assert.deepEqual(phase6LayerEventCounts(events), {
    INPUT: 9,
    INDICATOR_FEATURE: 9,
    SIGNAL: 1,
    EXECUTION: 2,
    RESULT: 2,
  });
  assert.equal(phase6TraceRootSha256(events), 'b2375924faa1ec7914b79e4727a70818c6896c107d9fd9b563eb3d6ee80ada05');
  assert.equal(events.some(event => event.layer === 'SIGNAL'), true);
  assert.equal(events.some(event => event.layer === 'EXECUTION'), true);
  assert.equal(events.some(event => event.layer === 'RESULT'), true);
});

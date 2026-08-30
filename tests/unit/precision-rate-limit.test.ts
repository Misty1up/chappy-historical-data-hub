import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRECISION_RATE_LIMIT_BASE_MS,
  PRECISION_RATE_LIMIT_CAP_MS,
  precisionMetadataRetryDelayMs,
} from '../../src/precision/upstream-multiplier.js';
import { classifyFailure } from '../../src/actions/execute-cli.js';

test('precision metadata 429 uses bounded longer backoff', () => {
  assert.equal(precisionMetadataRetryDelayMs(429, null, 1, 0), PRECISION_RATE_LIMIT_BASE_MS);
  assert.equal(precisionMetadataRetryDelayMs(429, null, 2, 0), PRECISION_RATE_LIMIT_BASE_MS * 2);
  assert.equal(precisionMetadataRetryDelayMs(429, '60', 1, 0), 60_000);
  assert.equal(precisionMetadataRetryDelayMs(429, '9999', 1, 0), PRECISION_RATE_LIMIT_CAP_MS);
  assert.equal(precisionMetadataRetryDelayMs(503, null, 1, 0), null);
});

test('precision metadata HTTP failure is not classified as INTERNAL_ERROR', () => {
  assert.equal(classifyFailure(new Error('Precision metadata request failed with HTTP 429')), 'PRECISION_NOT_VERIFIED');
  assert.equal(classifyFailure(new Error('Upstream precision payload missing times[] for hour 3')), 'PRECISION_NOT_VERIFIED');
  assert.equal(classifyFailure(new Error('unrelated failure')), 'INTERNAL_ERROR');
});

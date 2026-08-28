import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_DEFAULT_MAX_ATTEMPTS,
  PROJECT_RETRY_BASE_MS,
  PROJECT_RETRY_JITTER_MS,
  retryDelayMs,
} from '../../src/core/retry-policy.js';

test('Phase 1 defaults to four project-side attempts', () => {
  assert.equal(PROJECT_DEFAULT_MAX_ATTEMPTS, 4);
});

test('retry delay grows exponentially with bounded jitter', () => {
  assert.equal(retryDelayMs(1, 0), PROJECT_RETRY_BASE_MS);
  assert.equal(retryDelayMs(2, 0), PROJECT_RETRY_BASE_MS * 2);
  assert.equal(retryDelayMs(3, 0), PROJECT_RETRY_BASE_MS * 4);
  assert.equal(retryDelayMs(1, 1), PROJECT_RETRY_BASE_MS + PROJECT_RETRY_JITTER_MS);
});

test('retry delay rejects invalid attempt and random inputs', () => {
  assert.throws(() => retryDelayMs(0, 0));
  assert.throws(() => retryDelayMs(1, -0.1));
  assert.throws(() => retryDelayMs(1, 1.1));
});

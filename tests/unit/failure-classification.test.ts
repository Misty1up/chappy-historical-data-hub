import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../src/core/failure-classification.js';

test('network-like errors classify as FETCH_FAILED', () => {
  assert.equal(classifyError(new Error('network timeout while fetching HTTP resource')), 'FETCH_FAILED');
});

test('payload and cache failures use frozen failure classes', () => {
  assert.equal(classifyError(new Error('Unexpected payload type')), 'INVALID_PAYLOAD');
  assert.equal(classifyError(new Error('cache write failed')), 'CACHE_WRITE_FAILED');
});

test('hash and empty failures use frozen failure classes', () => {
  assert.equal(classifyError(new Error('hash mismatch')), 'HASH_MISMATCH');
  assert.equal(classifyError(new Error('upstream empty response')), 'UPSTREAM_EMPTY');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMultiplierPayload } from '../../src/precision/upstream-multiplier.js';

test('multiplier payload preserves raw numeric token and parsed value', () => {
  const payload = parseMultiplierPayload('{"times":[1,2,3],"multiplier":1e-7,"asks":[1],"bids":[1]}', 4);
  assert.equal(payload.tickDeltaCount, 3);
  assert.equal(payload.multiplierRaw, '1e-7');
  assert.equal(payload.multiplierParsed, 1e-7);
});

test('empty hourly payload may omit multiplier', () => {
  const payload = parseMultiplierPayload('{"times":[],"asks":[],"bids":[]}', 5);
  assert.deepEqual(payload, { tickDeltaCount: 0, multiplierRaw: null, multiplierParsed: null });
});

test('non-empty payload without multiplier is rejected', () => {
  assert.throws(
    () => parseMultiplierPayload('{"times":[1],"asks":[1],"bids":[1]}', 6),
    /missing multiplier/,
  );
});

test('non-numeric parsed multiplier is rejected even if raw token is absent', () => {
  assert.throws(
    () => parseMultiplierPayload('{"times":[1],"multiplier":"0.001"}', 7),
    /missing multiplier|not a positive finite number/,
  );
});

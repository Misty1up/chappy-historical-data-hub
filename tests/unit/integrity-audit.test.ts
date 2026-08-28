import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSourceTicks } from '../../src/core/integrity-audit.js';
import type { SourceTick } from '../../src/types/contracts.js';

function tick(timestamp: number, bid: number, ask: number, seq: number): SourceTick {
  return {
    timestamp_msc: BigInt(timestamp),
    bid,
    ask,
    bid_volume: 1,
    ask_volume: 1,
    source_seq: seq,
  };
}

test('duplicates and same-timestamp ticks are counted but not removed or failed', () => {
  const ticks = [
    tick(1000, 1.1, 1.2, 0),
    tick(1000, 1.1, 1.2, 1),
    tick(1000, 1.11, 1.21, 2),
  ];
  const audit = auditSourceTicks('2026-01-01', ticks);
  assert.equal(audit.status, 'PASS');
  assert.equal(audit.tick_count, 3);
  assert.equal(audit.exact_duplicate_count, 1);
  assert.equal(audit.same_timestamp_pair_count, 2);
});

test('out-of-order timestamps fail integrity', () => {
  const audit = auditSourceTicks('2026-01-01', [tick(2000, 1, 2, 0), tick(1000, 1, 2, 1)]);
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.out_of_order_count, 1);
});

test('invalid non-positive price fails integrity', () => {
  const audit = auditSourceTicks('2026-01-01', [tick(1000, 0, 1, 0)]);
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.invalid_price_count, 1);
});

test('negative spread fails integrity', () => {
  const audit = auditSourceTicks('2026-01-01', [tick(1000, 2, 1, 0)]);
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.negative_spread_count, 1);
});

test('empty response remains explicit WARN rather than synthetic fill', () => {
  const audit = auditSourceTicks('2026-01-01', []);
  assert.equal(audit.status, 'WARN');
  assert.equal(audit.failure_class, 'EMPTY_UNCLASSIFIED');
  assert.equal(audit.tick_count, 0);
});

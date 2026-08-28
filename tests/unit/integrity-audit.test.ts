import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSourceTicks } from '../../src/core/integrity-audit.js';
import type { SourceTick, UtcDayWindow } from '../../src/types/contracts.js';

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

const window: UtcDayWindow = {
  dateUtc: '2026-01-01',
  fromUtc: new Date('2026-01-01T00:00:00.000Z'),
  toUtc: new Date('2026-01-02T00:00:00.000Z'),
};

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

test('out-of-order timestamps fail as NON_MONOTONIC_INPUT', () => {
  const audit = auditSourceTicks('2026-01-01', [tick(2000, 1, 2, 0), tick(1000, 1, 2, 1)]);
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.out_of_order_count, 1);
  assert.equal(audit.failure_class, 'NON_MONOTONIC_INPUT');
});

test('invalid Bid and Ask are counted separately', () => {
  const invalidBid = auditSourceTicks('2026-01-01', [tick(1000, 0, 1, 0)]);
  assert.equal(invalidBid.status, 'FAIL');
  assert.equal(invalidBid.invalid_bid_count, 1);
  assert.equal(invalidBid.invalid_ask_count, 0);
  assert.equal(invalidBid.invalid_price_count, 1);
  assert.equal(invalidBid.failure_class, 'INVALID_BID');

  const invalidAsk = auditSourceTicks('2026-01-01', [tick(1000, 1, 0, 0)]);
  assert.equal(invalidAsk.status, 'FAIL');
  assert.equal(invalidAsk.invalid_bid_count, 0);
  assert.equal(invalidAsk.invalid_ask_count, 1);
  assert.equal(invalidAsk.invalid_price_count, 1);
  assert.equal(invalidAsk.failure_class, 'INVALID_ASK');
});

test('negative spread fails as NEGATIVE_SPREAD', () => {
  const audit = auditSourceTicks('2026-01-01', [tick(1000, 2, 1, 0)]);
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.negative_spread_count, 1);
  assert.equal(audit.failure_class, 'NEGATIVE_SPREAD');
});

test('requested range detects timestamps outside the UTC day', () => {
  const inside = window.fromUtc.getTime() + 1;
  const outside = window.toUtc.getTime();
  const audit = auditSourceTicks('2026-01-01', [tick(inside, 1, 2, 0), tick(outside, 1, 2, 1)], window);
  assert.equal(audit.status, 'FAIL');
  assert.equal(audit.out_of_range_count, 1);
  assert.equal(audit.failure_class, 'TIMESTAMP_OUT_OF_RANGE');
  assert.equal(audit.requested_from_utc, window.fromUtc.toISOString());
  assert.equal(audit.requested_to_utc, window.toUtc.toISOString());
});

test('empty response remains explicit WARN rather than synthetic fill', () => {
  const audit = auditSourceTicks('2026-01-01', [], window);
  assert.equal(audit.status, 'WARN');
  assert.equal(audit.failure_class, 'EMPTY_UNCLASSIFIED');
  assert.equal(audit.tick_count, 0);
});

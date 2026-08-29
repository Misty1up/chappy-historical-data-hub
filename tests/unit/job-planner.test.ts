import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUtcDate, planUtcDays } from '../../src/core/job-planner.js';

test('parseUtcDate accepts strict UTC calendar date', () => {
  assert.equal(parseUtcDate('2026-01-01').toISOString(), '2026-01-01T00:00:00.000Z');
});

test('parseUtcDate rejects impossible or non-canonical dates', () => {
  assert.throws(() => parseUtcDate('2026-02-30'));
  assert.throws(() => parseUtcDate('2026/01/01'));
});

test('planUtcDays uses inclusive from and exclusive to', () => {
  const days = planUtcDays('2026-01-01', '2026-01-04');
  assert.deepEqual(days.map(day => day.dateUtc), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.equal(days[0]!.fromUtc.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(days[2]!.toUtc.toISOString(), '2026-01-04T00:00:00.000Z');
});

test('planUtcDays rejects empty range', () => {
  assert.throws(() => planUtcDays('2026-01-01', '2026-01-01'));
});

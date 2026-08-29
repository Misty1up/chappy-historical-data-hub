import type { UtcDayWindow } from '../types/contracts.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseUtcDate(value: string): Date {
  if (!DATE_RE.test(value)) throw new Error(`Expected UTC calendar date YYYY-MM-DD, got: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid UTC calendar date: ${value}`);
  }
  return date;
}

export function planUtcDays(fromDate: string, toDate: string): UtcDayWindow[] {
  const from = parseUtcDate(fromDate);
  const to = parseUtcDate(toDate);
  if (from.getTime() >= to.getTime()) throw new Error('--from must be earlier than --to');

  const windows: UtcDayWindow[] = [];
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += 86_400_000) {
    const fromUtc = new Date(cursor);
    const toUtc = new Date(cursor + 86_400_000);
    windows.push({
      dateUtc: fromUtc.toISOString().slice(0, 10),
      fromUtc,
      toUtc,
    });
  }
  return windows;
}

import { sha256Text } from '../core/hash.js';
import type { CanonicalTick } from './types.js';

function canonicalFiniteNumber(value: number | null): string {
  if (value === null) return 'null';
  if (!Number.isFinite(value)) throw new Error(`Canonical volume must be finite or null: ${String(value)}`);
  return value.toString();
}

export function canonicalLogicalRowLine(row: CanonicalTick): string {
  return [
    row.timestamp_msc.toString(10),
    row.bid_scaled.toString(10),
    row.ask_scaled.toString(10),
    canonicalFiniteNumber(row.bid_volume),
    canonicalFiniteNumber(row.ask_volume),
    row.source_seq.toString(10),
  ].join('|');
}

export function canonicalLogicalRowHash(rows: CanonicalTick[]): string {
  const text = rows.length === 0
    ? ''
    : `${rows.map(canonicalLogicalRowLine).join('\n')}\n`;
  return sha256Text(text);
}

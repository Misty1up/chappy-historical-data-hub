import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { sha256File } from '../core/hash.js';
import type { SymbolRegistryEntry } from '../types/contracts.js';
import { decimalToScaledIntExact } from '../precision/decimal.js';
import { canonicalLogicalRowHash } from './logical-hash.js';
import type { CanonicalDayResult, CanonicalSourceLexemes, CanonicalTick } from './types.js';

const JSON_NUMBER = '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = (2n ** 63n) - 1n;

function ownedBytes(data: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i]!;
  return out;
}

function assertInt64(value: bigint, field: string, row: number): void {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new Error(`${field} is outside signed int64 at row ${row}: ${value.toString()}`);
  }
}

function extractStringField(line: string, field: string): string {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*)"`);
  const match = pattern.exec(line);
  if (!match?.[1]) throw new Error(`Snapshot line missing string ${field}`);
  return match[1];
}

function extractNumberField(line: string, field: string): string {
  const pattern = new RegExp(`"${field}"\\s*:\\s*(${JSON_NUMBER})`);
  const match = pattern.exec(line);
  if (!match?.[1]) throw new Error(`Snapshot line missing numeric ${field}`);
  return match[1];
}

function extractNullableNumberField(line: string, field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:\\s*(null|${JSON_NUMBER})`);
  const match = pattern.exec(line);
  if (!match?.[1]) throw new Error(`Snapshot line missing nullable numeric ${field}`);
  return match[1] === 'null' ? null : match[1];
}

function parseFiniteOrNull(raw: string | null, field: string, row: number): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${field} is non-finite at row ${row}: ${raw}`);
  return value;
}

function parseSourceLexemes(line: string, row: number): CanonicalSourceLexemes {
  const sourceSeqRaw = extractNumberField(line, 'source_seq');
  if (!/^\d+$/.test(sourceSeqRaw)) throw new Error(`source_seq is not a non-negative integer at row ${row}`);
  const sourceSeq = Number(sourceSeqRaw);
  if (!Number.isSafeInteger(sourceSeq)) throw new Error(`source_seq is unsafe at row ${row}: ${sourceSeqRaw}`);

  return {
    timestamp_msc: extractStringField(line, 'timestamp_msc'),
    bid: extractNumberField(line, 'bid'),
    ask: extractNumberField(line, 'ask'),
    bid_volume: extractNullableNumberField(line, 'bid_volume'),
    ask_volume: extractNullableNumberField(line, 'ask_volume'),
    source_seq: sourceSeq,
  };
}

function dayBounds(dateUtc: string): { start: bigint; end: bigint } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) throw new Error(`dateUtc must be YYYY-MM-DD: ${dateUtc}`);
  const startMs = Date.parse(`${dateUtc}T00:00:00.000Z`);
  if (!Number.isSafeInteger(startMs) || new Date(startMs).toISOString().slice(0, 10) !== dateUtc) {
    throw new Error(`Invalid UTC calendar date: ${dateUtc}`);
  }
  return { start: BigInt(startMs), end: BigInt(startMs + 86_400_000) };
}

export interface ConvertCanonicalDayInput {
  symbol: SymbolRegistryEntry;
  dateUtc: string;
  sourceSnapshotPath: string;
  expectedSourceSnapshotSha256: string;
  expectedSourceRowCount: number;
}

export async function convertSourceSnapshotToCanonicalDay(
  input: ConvertCanonicalDayInput,
): Promise<CanonicalDayResult> {
  if (input.symbol.precision_status !== 'VERIFIED' || input.symbol.price_digits === null || input.symbol.price_scale === null) {
    throw new Error(`Canonical conversion requires VERIFIED precision for ${input.symbol.canonical_symbol}`);
  }
  if (!Number.isSafeInteger(input.expectedSourceRowCount) || input.expectedSourceRowCount < 0) {
    throw new Error(`Invalid expectedSourceRowCount: ${input.expectedSourceRowCount}`);
  }

  const actualSnapshotSha = await sha256File(input.sourceSnapshotPath);
  if (actualSnapshotSha !== input.expectedSourceSnapshotSha256) {
    throw new Error(`Source snapshot SHA mismatch: expected=${input.expectedSourceSnapshotSha256} actual=${actualSnapshotSha}`);
  }

  const compressed = ownedBytes(await readFile(input.sourceSnapshotPath));
  const decompressed = ownedBytes(gunzipSync(compressed));
  const text = new TextDecoder('utf-8').decode(decompressed);
  const lines = text.length === 0 ? [] : text.trimEnd().split('\n');
  if (lines.length !== input.expectedSourceRowCount) {
    throw new Error(`Source row count mismatch: expected=${input.expectedSourceRowCount} actual=${lines.length}`);
  }

  const bounds = dayBounds(input.dateUtc);
  const rows: CanonicalTick[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lex = parseSourceLexemes(lines[index]!, index);
    if (lex.source_seq !== index) throw new Error(`Source order mismatch at row ${index}: source_seq=${lex.source_seq}`);
    if (!/^\d+$/.test(lex.timestamp_msc)) throw new Error(`Invalid timestamp_msc at row ${index}: ${lex.timestamp_msc}`);

    const timestamp = BigInt(lex.timestamp_msc);
    assertInt64(timestamp, 'timestamp_msc', index);
    if (timestamp < bounds.start || timestamp >= bounds.end) {
      throw new Error(`timestamp_msc outside requested UTC day at row ${index}: ${lex.timestamp_msc}`);
    }

    const bid = Number(lex.bid);
    const ask = Number(lex.ask);
    if (!Number.isFinite(bid) || bid <= 0) throw new Error(`Invalid bid at row ${index}: ${lex.bid}`);
    if (!Number.isFinite(ask) || ask <= 0) throw new Error(`Invalid ask at row ${index}: ${lex.ask}`);
    if (ask < bid) throw new Error(`Negative spread at row ${index}: bid=${lex.bid} ask=${lex.ask}`);

    const bidScaled = decimalToScaledIntExact(lex.bid, input.symbol.price_scale);
    const askScaled = decimalToScaledIntExact(lex.ask, input.symbol.price_scale);
    if (bidScaled === null) throw new Error(`Bid is off verified price lattice at row ${index}: ${lex.bid}`);
    if (askScaled === null) throw new Error(`Ask is off verified price lattice at row ${index}: ${lex.ask}`);
    assertInt64(bidScaled, 'bid_scaled', index);
    assertInt64(askScaled, 'ask_scaled', index);

    rows.push({
      timestamp_msc: timestamp,
      bid,
      ask,
      bid_volume: parseFiniteOrNull(lex.bid_volume, 'bid_volume', index),
      ask_volume: parseFiniteOrNull(lex.ask_volume, 'ask_volume', index),
      source_seq: lex.source_seq,
      bid_scaled: bidScaled,
      ask_scaled: askScaled,
    });
  }

  return {
    symbol: input.symbol.canonical_symbol,
    date_utc: input.dateUtc,
    price_digits: input.symbol.price_digits,
    price_scale: input.symbol.price_scale,
    source_snapshot_sha256: actualSnapshotSha,
    source_row_count: lines.length,
    canonical_row_count: rows.length,
    first_timestamp_msc: rows[0]?.timestamp_msc.toString(10) ?? null,
    last_timestamp_msc: rows.at(-1)?.timestamp_msc.toString(10) ?? null,
    logical_row_sha256: canonicalLogicalRowHash(rows),
    rows,
  };
}

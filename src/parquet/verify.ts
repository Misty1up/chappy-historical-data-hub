import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
} from 'hyparquet';
import { canonicalLogicalRowHash } from '../canonical/logical-hash.js';
import type { CanonicalTick } from '../canonical/types.js';
import { CANONICAL_PARQUET_COLUMNS } from './profile.js';

export interface CanonicalParquetVerification {
  row_count: number;
  schema_match: boolean;
  semantic_rows_match: boolean;
  logical_row_sha256: string;
  expected_logical_row_sha256: string;
  logical_hash_match: boolean;
}

function expectBigInt(value: unknown, field: string, row: number): bigint {
  if (typeof value !== 'bigint') throw new Error(`${field} readback is not bigint at row ${row}`);
  return value;
}

function expectNumber(value: unknown, field: string, row: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} readback is not finite number at row ${row}`);
  }
  return value;
}

function expectNullableNumber(value: unknown, field: string, row: number): number | null {
  if (value === null) return null;
  return expectNumber(value, field, row);
}

function expectSourceSeq(value: unknown, row: number): number {
  const numberValue = expectNumber(value, 'source_seq', row);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`source_seq readback is invalid at row ${row}: ${String(value)}`);
  }
  return numberValue;
}

function rowFromReadback(value: unknown, row: number): CanonicalTick {
  if (!value || typeof value !== 'object') throw new Error(`Parquet row ${row} is not an object`);
  const record = value as Record<string, unknown>;
  return {
    timestamp_msc: expectBigInt(record.timestamp_msc, 'timestamp_msc', row),
    source_seq: expectSourceSeq(record.source_seq, row),
    bid: expectNumber(record.bid, 'bid', row),
    ask: expectNumber(record.ask, 'ask', row),
    bid_scaled: expectBigInt(record.bid_scaled, 'bid_scaled', row),
    ask_scaled: expectBigInt(record.ask_scaled, 'ask_scaled', row),
    bid_volume: expectNullableNumber(record.bid_volume, 'bid_volume', row),
    ask_volume: expectNullableNumber(record.ask_volume, 'ask_volume', row),
  };
}

function rowExact(actual: CanonicalTick, expected: CanonicalTick): boolean {
  return actual.timestamp_msc === expected.timestamp_msc
    && actual.source_seq === expected.source_seq
    && Object.is(actual.bid, expected.bid)
    && Object.is(actual.ask, expected.ask)
    && actual.bid_scaled === expected.bid_scaled
    && actual.ask_scaled === expected.ask_scaled
    && Object.is(actual.bid_volume, expected.bid_volume)
    && Object.is(actual.ask_volume, expected.ask_volume);
}

function schemaSummary(metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>) {
  const tree = parquetSchema(metadata);
  return tree.children.map(child => ({
    name: child.element.name,
    physical_type: child.element.type,
    converted_type: child.element.converted_type ?? null,
    logical_type: child.element.logical_type ?? null,
    repetition_type: child.element.repetition_type,
  }));
}

const EXPECTED_SCHEMA = CANONICAL_PARQUET_COLUMNS.map(column => ({
  name: column.name,
  physical_type: column.type,
  converted_type: null,
  logical_type: null,
  repetition_type: column.nullable ? 'OPTIONAL' : 'REQUIRED',
}));

export async function verifyCanonicalParquetFile(
  filename: string,
  expectedRows: CanonicalTick[],
  expectedLogicalHash: string,
): Promise<CanonicalParquetVerification> {
  const file = await asyncBufferFromFile(filename);
  const metadata = await parquetMetadataAsync(file);
  const metadataRows = Number(metadata.num_rows);
  if (!Number.isSafeInteger(metadataRows) || metadataRows !== expectedRows.length) {
    throw new Error(`Parquet metadata row count mismatch: expected=${expectedRows.length} actual=${String(metadata.num_rows)}`);
  }

  const schema = schemaSummary(metadata);
  const schemaMatch = JSON.stringify(schema) === JSON.stringify(EXPECTED_SCHEMA);
  if (!schemaMatch) throw new Error(`Parquet schema mismatch: ${JSON.stringify(schema)}`);

  const readbackObjects = await parquetReadObjects({ file, metadata });
  if (readbackObjects.length !== expectedRows.length) {
    throw new Error(`Parquet readback row count mismatch: expected=${expectedRows.length} actual=${readbackObjects.length}`);
  }

  const readbackRows = readbackObjects.map((row, index) => rowFromReadback(row, index));
  const semanticRowsMatch = readbackRows.every((row, index) => rowExact(row, expectedRows[index]!));
  if (!semanticRowsMatch) throw new Error('Parquet semantic readback differs from Canonical rows');

  const logicalRowSha256 = canonicalLogicalRowHash(readbackRows);
  const logicalHashMatch = logicalRowSha256 === expectedLogicalHash;
  if (!logicalHashMatch) {
    throw new Error(`Parquet logical hash mismatch: expected=${expectedLogicalHash} actual=${logicalRowSha256}`);
  }

  return {
    row_count: readbackRows.length,
    schema_match: schemaMatch,
    semantic_rows_match: semanticRowsMatch,
    logical_row_sha256: logicalRowSha256,
    expected_logical_row_sha256: expectedLogicalHash,
    logical_hash_match: logicalHashMatch,
  };
}

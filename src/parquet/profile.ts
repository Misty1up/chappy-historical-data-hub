import type { CanonicalTick } from '../canonical/types.js';

export const PARQUET_WRITER_PACKAGE = 'hyparquet-writer' as const;
export const PARQUET_WRITER_VERSION = '0.16.8' as const;
export const PARQUET_READER_PACKAGE = 'hyparquet' as const;
export const PARQUET_READER_VERSION = '1.29.2' as const;

export const CANONICAL_PARQUET_PROFILE = {
  profile_id: 'HDH_CANONICAL_SNAPPY_V1',
  codec: 'SNAPPY',
  statistics: false,
  row_group_size: 100_000,
  dynamic_timestamp_metadata: false,
} as const;

export const CANONICAL_PARQUET_COLUMNS = [
  { name: 'timestamp_msc', type: 'INT64', nullable: false },
  { name: 'source_seq', type: 'INT32', nullable: false },
  { name: 'bid', type: 'DOUBLE', nullable: false },
  { name: 'ask', type: 'DOUBLE', nullable: false },
  { name: 'bid_scaled', type: 'INT64', nullable: false },
  { name: 'ask_scaled', type: 'INT64', nullable: false },
  { name: 'bid_volume', type: 'DOUBLE', nullable: true },
  { name: 'ask_volume', type: 'DOUBLE', nullable: true },
] as const;

export function canonicalParquetColumnData(rows: CanonicalTick[]) {
  return CANONICAL_PARQUET_COLUMNS.map(column => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    data: rows.map(row => row[column.name]),
  }));
}

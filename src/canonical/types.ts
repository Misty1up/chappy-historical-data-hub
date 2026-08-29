export interface CanonicalTick {
  timestamp_msc: bigint;
  bid: number;
  ask: number;
  bid_volume: number | null;
  ask_volume: number | null;
  source_seq: number;
  bid_scaled: bigint;
  ask_scaled: bigint;
}

export interface CanonicalSourceLexemes {
  timestamp_msc: string;
  bid: string;
  ask: string;
  bid_volume: string | null;
  ask_volume: string | null;
  source_seq: number;
}

export interface CanonicalDayResult {
  symbol: string;
  date_utc: string;
  price_digits: number;
  price_scale: number;
  source_snapshot_sha256: string;
  source_row_count: number;
  canonical_row_count: number;
  first_timestamp_msc: string | null;
  last_timestamp_msc: string | null;
  logical_row_sha256: string;
  rows: CanonicalTick[];
}

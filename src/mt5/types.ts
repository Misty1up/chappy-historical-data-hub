export const MT5_DERIVATIVE_PROFILE_ID = 'HDH_MT5_MQLTICK_CSV_V1' as const;

export interface Mt5TickDerivativeRow {
  time_msc: bigint;
  source_seq: number;
  bid: string;
  ask: string;
  bid_scaled: bigint;
  ask_scaled: bigint;
}

export interface Mt5TickDerivativeDay {
  schema_version: '0.1.0';
  profile_id: typeof MT5_DERIVATIVE_PROFILE_ID;
  symbol: string;
  date_utc: string;
  price_digits: number;
  price_scale: number;
  source_snapshot_sha256: string;
  canonical_logical_row_sha256: string;
  canonical_row_count: number;
  from_msc: bigint;
  to_msc: bigint;
  order_policy: 'SOURCE_SEQ_PRESERVED_NONDECREASING_TIME';
  same_timestamp_policy: 'PRESERVED';
  dedupe_applied: false;
  gap_fill_applied: false;
  bid_ask_mapping: 'DIRECT_FROM_CANONICAL_SCALED';
  volume_mapping_policy: 'UNMAPPED_BID_ASK_VOLUME_REMAINS_CANONICAL_ONLY';
  dataset_binding_status: 'PENDING_P2_5_PACKET';
  rows: Mt5TickDerivativeRow[];
}

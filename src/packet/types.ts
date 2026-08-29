export interface PacketFileBinding {
  date_utc: string;
  path: string;
  physical_sha256: string;
  file_size_bytes: number;
  canonical_logical_row_hash: string;
  row_count: number;
  source_snapshot_sha256: string;
}

export interface CanonicalDailyPacketAudit {
  symbol: string;
  date_utc: string;
  source_snapshot_sha256: string;
  source_tick_count: number;
  canonical_tick_count: number;
  first_timestamp_msc: string | null;
  last_timestamp_msc: string | null;
  exact_duplicate_count: number;
  same_timestamp_group_count: number;
  out_of_order_count: number;
  invalid_bid_count: number;
  invalid_ask_count: number;
  negative_spread_count: number;
  bid_scaled_conversion_fail_count: 0;
  ask_scaled_conversion_fail_count: 0;
  parquet_sha256: string;
  canonical_logical_row_hash: string;
  source_order_preservation: 'PASS';
  hash_chain_status: 'PASS';
  status: 'PASS';
}

export interface DatasetPacketManifest {
  manifest_schema_version: '0.1.0';
  dataset_id: string;
  canonical_schema_version: '0.1';
  generator_git_commit: string;
  source_run_id: string;
  source_hash_root: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  tick_count_total: number;
  canonical_file_count: number;
  price_digits: number;
  price_scale: number;
  precision_status: 'VERIFIED';
  precision_evidence_sha256: string;
  canonical_logical_hash_root: string;
  parquet_file_hash_root: string;
  mt5_derivative_hash_root: string;
  integrity_status: 'PASS';
  canonical_promotion_allowed: true;
  generated_at_utc: string;
}

export interface DatasetPacketBuildResult {
  manifest: DatasetPacketManifest;
  sha256sums_checked_files: number;
}

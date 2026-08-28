export type PrecisionStatus = 'UNVERIFIED' | 'VERIFIED';
export type StartHintStatus = 'REFERENCE_ONLY' | 'VERIFIED_BY_FETCH';

export interface SymbolRegistryEntry {
  canonical_symbol: string;
  enabled: boolean;
  source_adapter_id: 'dukascopy-node';
  source_instrument: string;
  source_feed_type: 'tick';
  source_start_hint_utc: string;
  source_start_hint_provenance: string;
  source_start_hint_status: StartHintStatus;
  precision_status: PrecisionStatus;
  price_digits: number | null;
  price_scale: number | null;
}

export interface SymbolRegistry {
  schema_version: string;
  symbols: SymbolRegistryEntry[];
}

export interface SourceTick {
  timestamp_msc: bigint;
  bid: number;
  ask: number;
  bid_volume: number | null;
  ask_volume: number | null;
  source_seq: number;
}

export interface SerializableSourceTick {
  timestamp_msc: string;
  bid: number;
  ask: number;
  bid_volume: number | null;
  ask_volume: number | null;
  source_seq: number;
}

export interface FetchTicksOptions {
  batchSize: number;
  pauseBetweenBatchesMs: number;
}

export interface UtcDayWindow {
  dateUtc: string;
  fromUtc: Date;
  toUtc: Date;
}

export type DailyAuditStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DailyAudit {
  date_utc: string;
  status: DailyAuditStatus;
  tick_count: number;
  first_timestamp_msc: string | null;
  last_timestamp_msc: string | null;
  exact_duplicate_count: number;
  same_timestamp_pair_count: number;
  out_of_order_count: number;
  invalid_price_count: number;
  negative_spread_count: number;
  null_bid_volume_count: number;
  null_ask_volume_count: number;
  snapshot_path: string | null;
  snapshot_sha256: string | null;
  failure_class: string | null;
  note: string | null;
}

export interface JobConfig {
  task_id: string;
  symbol: string;
  from_utc: string;
  to_utc: string;
  out_dir: string;
  batch_size: number;
  batch_pause_ms: number;
  max_attempts: number;
  force: boolean;
}

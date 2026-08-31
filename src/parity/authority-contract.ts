import { LOCAL_HANDOFF_SCHEMA_VERSION } from '../local/handoff.js';

export const PHASE6_INPUT_BINDING_SCHEMA_VERSION = 'HDH_P6_INPUT_BINDING_V1' as const;
export const PHASE6_CANONICAL_TIMESTAMP_SEMANTICS = 'UTC_UNIX_EPOCH_MILLISECONDS' as const;
export const PHASE6_CANONICAL_SOURCE_ORDER_SEMANTICS = 'ORIGINAL_SOURCE_ORDER_PRESERVED' as const;
export const PHASE6_MT5_PROFILE_ID = 'HDH_MT5_MQLTICK_CSV_V1' as const;
export const PHASE6_MT5_ORDER_POLICY = 'SOURCE_SEQ_PRESERVED_NONDECREASING_TIME' as const;
export const PHASE6_SAME_TIMESTAMP_POLICY = 'PRESERVED' as const;
export const PHASE6_BID_ASK_MAPPING = 'DIRECT_FROM_CANONICAL_SCALED' as const;
export const PHASE6_VOLUME_MAPPING_POLICY = 'UNMAPPED_BID_ASK_VOLUME_REMAINS_CANONICAL_ONLY' as const;
export const PHASE6_MT5_CSV_COLUMNS = ['time_msc', 'bid', 'ask', 'bid_scaled', 'ask_scaled', 'source_seq'] as const;

export type Phase6InputBindingFailureCode =
  | 'ACCEPTED_LOCAL_DATASET_UNAVAILABLE'
  | 'P6_INPUT_BINDING_MISMATCH'
  | 'P6_INPUT_CONTRACT_UNSUPPORTED';

export class Phase6InputBindingError extends Error {
  constructor(
    public readonly code: Phase6InputBindingFailureCode,
    public readonly status: 'FAIL' | 'HOLD',
    message: string,
  ) {
    super(message);
    this.name = 'Phase6InputBindingError';
  }
}

export interface Phase6AuthorityFileBinding {
  date_utc: string;
  packet_relative_path: string;
  local_path: string;
  physical_sha256: string;
  canonical_logical_row_hash: string;
  source_snapshot_sha256: string;
  row_count: number;
  file_size_bytes: number;
}

export interface Phase6InputBinding {
  input_binding_schema_version: typeof PHASE6_INPUT_BINDING_SCHEMA_VERSION;
  binding_status: 'PASS';
  handoff_schema_version: typeof LOCAL_HANDOFF_SCHEMA_VERSION;
  registry_schema_version: string;
  dataset_id: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  tick_count_total: number;
  source_hash_root: string;
  canonical_logical_hash_root: string;
  parquet_file_hash_root: string;
  mt5_derivative_hash_root: string;
  price_digits: number;
  price_scale: number;
  canonical_contract: {
    timestamp_field: 'timestamp_msc';
    timestamp_semantics: typeof PHASE6_CANONICAL_TIMESTAMP_SEMANTICS;
    source_order_field: 'source_seq';
    source_order_semantics: typeof PHASE6_CANONICAL_SOURCE_ORDER_SEMANTICS;
    exact_price_fields: readonly ['bid_scaled', 'ask_scaled'];
    same_timestamp_policy: typeof PHASE6_SAME_TIMESTAMP_POLICY;
  };
  packet_integrity: {
    integrity_status: 'PASS';
    canonical_promotion_allowed: true;
    registry_verify_status: 'PASS';
    packet_revalidation_status: 'PASS';
    manifest_sha256: string;
    sha256sums_sha256: string;
  };
  local_paths: {
    data_packet: string;
    numba_dataset_json: string;
    mt5_symbol_contract_json: string;
  };
  numba: {
    dataset_binding_status: 'BOUND_P2_5_PACKET';
    canonical_schema_version: '0.1';
    file_count: number;
    row_count_total: number;
    parquet_files: Phase6AuthorityFileBinding[];
  };
  mt5: {
    dataset_binding_status: 'BOUND_P2_5_PACKET';
    canonical_schema_version: '0.1';
    profile_id: typeof PHASE6_MT5_PROFILE_ID;
    csv_columns: typeof PHASE6_MT5_CSV_COLUMNS;
    mqltick_mapping: {
      time: 'floor(time_msc/1000)';
      time_msc: 'DIRECT';
      bid: 'DIRECT_CANONICAL_PRICE';
      ask: 'DIRECT_CANONICAL_PRICE';
      last: '0';
      volume: '0';
      volume_real: '0';
      flags: 'TICK_FLAG_BID|TICK_FLAG_ASK';
    };
    order_policy: typeof PHASE6_MT5_ORDER_POLICY;
    same_timestamp_policy: typeof PHASE6_SAME_TIMESTAMP_POLICY;
    dedupe_applied: false;
    gap_fill_applied: false;
    bid_ask_mapping: typeof PHASE6_BID_ASK_MAPPING;
    volume_mapping_policy: typeof PHASE6_VOLUME_MAPPING_POLICY;
    file_count: number;
    row_count_total: number;
    tick_files: Phase6AuthorityFileBinding[];
  };
  mutation_guard: {
    packet_mutation_performed: false;
    registry_mutation_performed: false;
    terminal_mt5_mutation_performed: false;
    strategy_evaluation_performed: false;
    numba_mt5_parity_declared: false;
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalConsumerHandoffResult } from '../../src/local/handoff.js';
import {
  PHASE6_CANONICAL_TIMESTAMP_SEMANTICS,
  PHASE6_INPUT_BINDING_SCHEMA_VERSION,
  PHASE6_MT5_PROFILE_ID,
  Phase6InputBindingError,
  bindPhase6AcceptedInput,
} from '../../src/parity/authority.js';

const DATASET_ID = `HDH_DATASET_V1_${'1'.repeat(64)}`;
const SOURCE_ROOT = '2'.repeat(64);
const CANONICAL_ROOT = '3'.repeat(64);
const PARQUET_ROOT = '4'.repeat(64);
const MT5_ROOT = '5'.repeat(64);
const MANIFEST_SHA = '6'.repeat(64);
const SUMS_SHA = '7'.repeat(64);
const CANONICAL_ROW_HASH = '8'.repeat(64);
const SOURCE_SNAPSHOT_SHA = '9'.repeat(64);
const PARQUET_SHA = 'a'.repeat(64);
const MT5_SHA = 'b'.repeat(64);
const DATE_UTC = '2026-01-05';
const PARQUET_PATH = `canonical/EURUSD/2026/01/${DATE_UTC}.parquet`;
const MT5_PATH = `mt5/ticks/EURUSD/2026/01/${DATE_UTC}.ticks.csv`;

function fixtures() {
  const common = {
    schema_version: '0.1.0',
    dataset_id: DATASET_ID,
    dataset_binding_status: 'BOUND_P2_5_PACKET',
    canonical_schema_version: '0.1',
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    source_hash_root: SOURCE_ROOT,
    canonical_logical_hash_root: CANONICAL_ROOT,
    price_digits: 5,
    price_scale: 100000,
  };
  const parquetBinding = {
    date_utc: DATE_UTC,
    path: PARQUET_PATH,
    physical_sha256: PARQUET_SHA,
    file_size_bytes: 123,
    canonical_logical_row_hash: CANONICAL_ROW_HASH,
    row_count: 2,
    source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
  };
  const mt5Binding = {
    ...parquetBinding,
    path: MT5_PATH,
    physical_sha256: MT5_SHA,
    file_size_bytes: 234,
  };
  const manifest = {
    manifest_schema_version: '0.1.0',
    dataset_id: DATASET_ID,
    canonical_schema_version: '0.1',
    generator_git_commit: 'c'.repeat(40),
    source_run_id: 'SYNTHETIC_SOURCE_RUN',
    source_hash_root: SOURCE_ROOT,
    symbol: 'EURUSD',
    requested_from_utc: common.requested_from_utc,
    requested_to_utc: common.requested_to_utc,
    tick_count_total: 2,
    canonical_file_count: 1,
    price_digits: 5,
    price_scale: 100000,
    precision_status: 'VERIFIED',
    precision_evidence_sha256: 'd'.repeat(64),
    canonical_logical_hash_root: CANONICAL_ROOT,
    parquet_file_hash_root: PARQUET_ROOT,
    mt5_derivative_hash_root: MT5_ROOT,
    integrity_status: 'PASS',
    canonical_promotion_allowed: true,
    generated_at_utc: '2026-08-31T00:00:00.000Z',
  };
  const numba = { ...common, parquet_files: [parquetBinding] };
  const mt5 = {
    ...common,
    profile_id: PHASE6_MT5_PROFILE_ID,
    csv_columns: ['time_msc', 'bid', 'ask', 'bid_scaled', 'ask_scaled', 'source_seq'],
    mqltick_mapping: {
      time: 'floor(time_msc/1000)',
      time_msc: 'DIRECT',
      bid: 'DIRECT_CANONICAL_PRICE',
      ask: 'DIRECT_CANONICAL_PRICE',
      last: '0',
      volume: '0',
      volume_real: '0',
      flags: 'TICK_FLAG_BID|TICK_FLAG_ASK',
    },
    order_policy: 'SOURCE_SEQ_PRESERVED_NONDECREASING_TIME',
    same_timestamp_policy: 'PRESERVED',
    dedupe_applied: false,
    gap_fill_applied: false,
    bid_ask_mapping: 'DIRECT_FROM_CANONICAL_SCALED',
    volume_mapping_policy: 'UNMAPPED_BID_ASK_VOLUME_REMAINS_CANONICAL_ONLY',
    tick_files: [mt5Binding],
  };
  const handoff: LocalConsumerHandoffResult = {
    handoff_schema_version: 'HDH_LOCAL_HANDOFF_V1',
    handoff_status: 'PASS',
    dataset_id: DATASET_ID,
    symbol: 'EURUSD',
    requested_from_utc: common.requested_from_utc,
    requested_to_utc: common.requested_to_utc,
    local_packet_path: '/synthetic/DATA_PACKET',
    authority: {
      source_hash_root: SOURCE_ROOT,
      canonical_logical_hash_root: CANONICAL_ROOT,
      parquet_file_hash_root: PARQUET_ROOT,
      mt5_derivative_hash_root: MT5_ROOT,
      manifest_sha256: MANIFEST_SHA,
      sha256sums_sha256: SUMS_SHA,
    },
    registry: {
      registry_schema_version: 'HDH_LOCAL_REGISTRY_V1',
      registry_verify_status: 'PASS',
      packet_revalidation_status: 'PASS',
      dataset: {
        dataset_id: DATASET_ID,
        local_packet_path: '/synthetic/DATA_PACKET',
        symbol: 'EURUSD',
        requested_from_utc: common.requested_from_utc,
        requested_to_utc: common.requested_to_utc,
        tick_count_total: 2,
        source_hash_root: SOURCE_ROOT,
        canonical_logical_hash_root: CANONICAL_ROOT,
        parquet_file_hash_root: PARQUET_ROOT,
        mt5_derivative_hash_root: MT5_ROOT,
        integrity_status: 'PASS',
        canonical_promotion_allowed: true,
        manifest_sha256: MANIFEST_SHA,
        sha256sums_sha256: SUMS_SHA,
        import_status: 'IMPORTED',
        import_run_id: 'synthetic-import',
        imported_at_utc: '2026-08-31T00:00:00.000Z',
        source_transport_type: 'DIRECTORY',
        workflow_run_id: null,
        artifact_id: null,
        artifact_digest: null,
      },
    },
    numba: {
      dataset_json_path: '/synthetic/DATA_PACKET/numba/dataset.json',
      canonical_parquet_files: [{
        date_utc: DATE_UTC,
        packet_relative_path: PARQUET_PATH,
        local_path: `/synthetic/DATA_PACKET/${PARQUET_PATH}`,
        physical_sha256: PARQUET_SHA,
        canonical_logical_row_hash: CANONICAL_ROW_HASH,
        source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
        row_count: 2,
        file_size_bytes: 123,
      }],
      handoff_description: 'synthetic',
    },
    mt5: {
      symbol_contract_path: '/synthetic/DATA_PACKET/mt5/symbol_contract.json',
      tick_root_path: '/synthetic/DATA_PACKET/mt5/ticks',
      tick_symbol_path: '/synthetic/DATA_PACKET/mt5/ticks/EURUSD',
      tick_files: [{
        date_utc: DATE_UTC,
        packet_relative_path: MT5_PATH,
        local_path: `/synthetic/DATA_PACKET/${MT5_PATH}`,
        physical_sha256: MT5_SHA,
        canonical_logical_row_hash: CANONICAL_ROW_HASH,
        source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
        row_count: 2,
        file_size_bytes: 234,
      }],
      handoff_description: 'synthetic',
    },
    packet_mutation_performed: false,
    registry_mutation_performed: false,
    terminal_mt5_mutation_performed: false,
    strategy_evaluation_performed: false,
    numba_mt5_parity_declared: false,
  };
  return { handoff, manifest, numba, mt5 };
}

function p6BindingError(code = 'P6_INPUT_BINDING_MISMATCH') {
  return (cause: unknown): boolean => cause instanceof Phase6InputBindingError && cause.code === code && cause.status === 'HOLD';
}

test('P6.1 binds the accepted Phase 5 authority without changing data semantics', () => {
  const { handoff, manifest, numba, mt5 } = fixtures();
  const result = bindPhase6AcceptedInput(handoff, manifest, numba, mt5);
  assert.equal(result.input_binding_schema_version, PHASE6_INPUT_BINDING_SCHEMA_VERSION);
  assert.equal(result.binding_status, 'PASS');
  assert.equal(result.dataset_id, DATASET_ID);
  assert.equal(result.tick_count_total, 2);
  assert.equal(result.source_hash_root, SOURCE_ROOT);
  assert.equal(result.canonical_logical_hash_root, CANONICAL_ROOT);
  assert.equal(result.parquet_file_hash_root, PARQUET_ROOT);
  assert.equal(result.mt5_derivative_hash_root, MT5_ROOT);
  assert.equal(result.price_digits, 5);
  assert.equal(result.price_scale, 100000);
  assert.equal(result.canonical_contract.timestamp_semantics, PHASE6_CANONICAL_TIMESTAMP_SEMANTICS);
  assert.equal(result.canonical_contract.source_order_field, 'source_seq');
  assert.deepEqual(result.canonical_contract.exact_price_fields, ['bid_scaled', 'ask_scaled']);
  assert.equal(result.numba.row_count_total, 2);
  assert.equal(result.mt5.row_count_total, 2);
  assert.equal(result.mt5.order_policy, 'SOURCE_SEQ_PRESERVED_NONDECREASING_TIME');
  assert.equal(result.mt5.same_timestamp_policy, 'PRESERVED');
  assert.equal(result.mt5.bid_ask_mapping, 'DIRECT_FROM_CANONICAL_SCALED');
  assert.deepEqual(result.mutation_guard, {
    packet_mutation_performed: false,
    registry_mutation_performed: false,
    terminal_mt5_mutation_performed: false,
    strategy_evaluation_performed: false,
    numba_mt5_parity_declared: false,
  });
});

test('P6.1 rejects dataset/hash/count/precision authority mismatches', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixtures>) => { f.numba.dataset_id = `HDH_DATASET_V1_${'f'.repeat(64)}`; },
    (f: ReturnType<typeof fixtures>) => { f.manifest.source_hash_root = 'e'.repeat(64); },
    (f: ReturnType<typeof fixtures>) => { f.manifest.parquet_file_hash_root = 'e'.repeat(64); },
    (f: ReturnType<typeof fixtures>) => { f.manifest.mt5_derivative_hash_root = 'e'.repeat(64); },
    (f: ReturnType<typeof fixtures>) => { f.manifest.tick_count_total = 3; },
    (f: ReturnType<typeof fixtures>) => { f.mt5.price_scale = 10000; },
  ]) {
    const f = fixtures();
    mutate(f);
    assert.throws(() => bindPhase6AcceptedInput(f.handoff, f.manifest, f.numba, f.mt5), p6BindingError());
  }
});

test('P6.1 rejects daily Canonical identity drift between Numba and MT5 bindings', () => {
  const f = fixtures();
  f.mt5.tick_files[0]!.canonical_logical_row_hash = 'c'.repeat(64);
  assert.throws(() => bindPhase6AcceptedInput(f.handoff, f.manifest, f.numba, f.mt5), p6BindingError());
});

test('P6.1 rejects MT5 timestamp/order/Bid-Ask policy reinterpretation', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixtures>) => { f.mt5.mqltick_mapping.time_msc = 'SECONDS'; },
    (f: ReturnType<typeof fixtures>) => { f.mt5.order_policy = 'SORT_BY_TIMESTAMP'; },
    (f: ReturnType<typeof fixtures>) => { f.mt5.same_timestamp_policy = 'MERGED'; },
    (f: ReturnType<typeof fixtures>) => { f.mt5.bid_ask_mapping = 'SWAPPED'; },
    (f: ReturnType<typeof fixtures>) => { f.mt5.dedupe_applied = true; },
    (f: ReturnType<typeof fixtures>) => { f.mt5.gap_fill_applied = true; },
  ]) {
    const f = fixtures();
    mutate(f);
    assert.throws(() => bindPhase6AcceptedInput(f.handoff, f.manifest, f.numba, f.mt5), p6BindingError());
  }
});

test('P6.1 rejects a handoff reference whose physical file identity changed', () => {
  const f = fixtures();
  f.handoff.mt5.tick_files[0]!.physical_sha256 = 'd'.repeat(64);
  assert.throws(() => bindPhase6AcceptedInput(f.handoff, f.manifest, f.numba, f.mt5), p6BindingError());
});

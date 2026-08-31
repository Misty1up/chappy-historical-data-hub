import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { Phase6InputBinding } from '../../src/parity/authority.js';
import {
  PHASE6_PARITY_RUN_SPEC_SCHEMA_VERSION,
  Phase6RunContractError,
  createPhase6ParityRunSpec,
  validatePhase6ParityRunSpec,
} from '../../src/parity/run-contract.js';

function inputBinding(): Phase6InputBinding {
  const file = {
    date_utc: '2026-01-05',
    packet_relative_path: 'synthetic/file',
    local_path: '/synthetic/file',
    physical_sha256: '1'.repeat(64),
    canonical_logical_row_hash: '2'.repeat(64),
    source_snapshot_sha256: '3'.repeat(64),
    row_count: 2,
    file_size_bytes: 10,
  };
  return {
    input_binding_schema_version: 'HDH_P6_INPUT_BINDING_V1',
    binding_status: 'PASS',
    handoff_schema_version: 'HDH_LOCAL_HANDOFF_V1',
    registry_schema_version: 'HDH_LOCAL_REGISTRY_V1',
    dataset_id: `HDH_DATASET_V1_${'4'.repeat(64)}`,
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    tick_count_total: 2,
    source_hash_root: '5'.repeat(64),
    canonical_logical_hash_root: '6'.repeat(64),
    parquet_file_hash_root: '7'.repeat(64),
    mt5_derivative_hash_root: '8'.repeat(64),
    price_digits: 5,
    price_scale: 100000,
    canonical_contract: {
      timestamp_field: 'timestamp_msc',
      timestamp_semantics: 'UTC_UNIX_EPOCH_MILLISECONDS',
      source_order_field: 'source_seq',
      source_order_semantics: 'ORIGINAL_SOURCE_ORDER_PRESERVED',
      exact_price_fields: ['bid_scaled', 'ask_scaled'],
      same_timestamp_policy: 'PRESERVED',
    },
    packet_integrity: {
      integrity_status: 'PASS',
      canonical_promotion_allowed: true,
      registry_verify_status: 'PASS',
      packet_revalidation_status: 'PASS',
      manifest_sha256: '9'.repeat(64),
      sha256sums_sha256: 'a'.repeat(64),
    },
    local_paths: {
      data_packet: '/synthetic/DATA_PACKET',
      numba_dataset_json: '/synthetic/DATA_PACKET/numba/dataset.json',
      mt5_symbol_contract_json: '/synthetic/DATA_PACKET/mt5/symbol_contract.json',
    },
    numba: {
      dataset_binding_status: 'BOUND_P2_5_PACKET',
      canonical_schema_version: '0.1',
      file_count: 1,
      row_count_total: 2,
      parquet_files: [file],
    },
    mt5: {
      dataset_binding_status: 'BOUND_P2_5_PACKET',
      canonical_schema_version: '0.1',
      profile_id: 'HDH_MT5_MQLTICK_CSV_V1',
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
      file_count: 1,
      row_count_total: 2,
      tick_files: [{ ...file, packet_relative_path: 'synthetic/mt5-file', local_path: '/synthetic/mt5-file' }],
    },
    mutation_guard: {
      packet_mutation_performed: false,
      registry_mutation_performed: false,
      terminal_mt5_mutation_performed: false,
      strategy_evaluation_performed: false,
      numba_mt5_parity_declared: false,
    },
  };
}

function config() {
  return {
    repository_commit: 'b'.repeat(40),
    numba_adapter_version: 'SYNTHETIC_NUMBA_CONTRACT_FIXTURE_V1',
    mt5_adapter_version: 'SYNTHETIC_MT5_CONTRACT_FIXTURE_V1',
    logic_contract_id: 'SYNTHETIC_LOGIC_CONTRACT_V1',
    logic_contract_sha256: 'c'.repeat(64),
    comparator_profile_id: 'SYNTHETIC_COMPARATOR_PROFILE_V1',
    comparator_profile_sha256: 'd'.repeat(64),
    environment_versions: { node: '22.0.0', platform: 'synthetic' },
    output_evidence_root: '/synthetic/P6_RUN',
  };
}

function runError(cause: unknown): boolean {
  return cause instanceof Phase6RunContractError && cause.code === 'P6_RUN_CONTRACT_INVALID' && cause.status === 'HOLD';
}

test('P6.1 run contract binds all frozen authority and declared version/hash inputs', () => {
  const input = inputBinding();
  const spec = createPhase6ParityRunSpec(input, config());
  assert.equal(spec.parity_run_spec_schema_version, PHASE6_PARITY_RUN_SPEC_SCHEMA_VERSION);
  assert.match(spec.parity_run_id, /^HDH_P6_RUN_V1_[0-9a-f]{64}$/);
  assert.equal(spec.dataset_id, input.dataset_id);
  assert.equal(spec.source_hash_root, input.source_hash_root);
  assert.equal(spec.canonical_logical_hash_root, input.canonical_logical_hash_root);
  assert.equal(spec.parquet_file_hash_root, input.parquet_file_hash_root);
  assert.equal(spec.mt5_derivative_hash_root, input.mt5_derivative_hash_root);
  assert.equal(spec.tick_count_total, input.tick_count_total);
  assert.equal(spec.price_digits, input.price_digits);
  assert.equal(spec.price_scale, input.price_scale);
  assert.equal(spec.timestamp_semantics, 'UTC_UNIX_EPOCH_MILLISECONDS');
  assert.equal(spec.source_order_semantics, 'ORIGINAL_SOURCE_ORDER_PRESERVED');
  assert.equal(spec.same_timestamp_policy, 'PRESERVED');
  assert.equal(spec.mt5_profile_id, 'HDH_MT5_MQLTICK_CSV_V1');
  assert.equal(spec.mt5_order_policy, 'SOURCE_SEQ_PRESERVED_NONDECREASING_TIME');
  assert.equal(spec.bid_ask_mapping, 'DIRECT_FROM_CANONICAL_SCALED');
  validatePhase6ParityRunSpec(spec);
});

test('P6.1 parity_run_id is deterministic and changes when a bound contract input changes', () => {
  const input = inputBinding();
  const first = createPhase6ParityRunSpec(input, config());
  const second = createPhase6ParityRunSpec(input, { ...config(), environment_versions: { platform: 'synthetic', node: '22.0.0' } });
  assert.equal(first.parity_run_id, second.parity_run_id);

  const changed = config();
  changed.comparator_profile_sha256 = 'e'.repeat(64);
  assert.notEqual(first.parity_run_id, createPhase6ParityRunSpec(input, changed).parity_run_id);
});

test('P6.1 refuses undeclared/invalid logic or comparator bindings', () => {
  const input = inputBinding();
  for (const mutate of [
    (value: ReturnType<typeof config>) => { value.logic_contract_id = ''; },
    (value: ReturnType<typeof config>) => { value.logic_contract_sha256 = 'bad'; },
    (value: ReturnType<typeof config>) => { value.comparator_profile_id = ''; },
    (value: ReturnType<typeof config>) => { value.comparator_profile_sha256 = 'bad'; },
    (value: ReturnType<typeof config>) => { value.repository_commit = 'bad'; },
  ]) {
    const value = config();
    mutate(value);
    assert.throws(() => createPhase6ParityRunSpec(input, value), runError);
  }
});

test('P6.1 detects same-run contract tampering through parity_run_id validation', () => {
  const spec = createPhase6ParityRunSpec(inputBinding(), config());
  const tampered = { ...spec, price_scale: 10000 };
  assert.throws(() => validatePhase6ParityRunSpec(tampered), runError);
});

test('P6.1 public schemas require frozen authority fields without market payload', async () => {
  const inputSchema = JSON.parse(await readFile(resolve('schemas/phase6_input_binding.schema.json'), 'utf8')) as Record<string, unknown>;
  const runSchema = JSON.parse(await readFile(resolve('schemas/phase6_parity_run_spec.schema.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(runSchema.additionalProperties, false);
  const required = runSchema.required as string[];
  for (const field of [
    'dataset_id', 'source_hash_root', 'canonical_logical_hash_root', 'parquet_file_hash_root', 'mt5_derivative_hash_root',
    'tick_count_total', 'symbol', 'requested_from_utc', 'requested_to_utc', 'price_digits', 'price_scale',
    'timestamp_semantics', 'source_order_semantics', 'same_timestamp_policy', 'mt5_profile_id', 'mt5_order_policy', 'bid_ask_mapping', 'volume_mapping_policy',
    'repository_commit', 'numba_adapter_version', 'mt5_adapter_version', 'logic_contract_id', 'logic_contract_sha256',
    'comparator_profile_id', 'comparator_profile_sha256', 'environment_versions', 'output_evidence_root',
  ]) assert.ok(required.includes(field), `missing required run binding: ${field}`);
  const serialized = JSON.stringify({ inputSchema, runSchema });
  assert.equal(serialized.includes('HDH_DATASET_V1_704e2be6a75216952161f8e152518057900f29e20a670e2f5898cdbf34dda926'), false);
});

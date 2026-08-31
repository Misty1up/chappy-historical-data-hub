export * from './authority-contract.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LOCAL_HANDOFF_SCHEMA_VERSION,
  buildLocalConsumerHandoff,
  type LocalConsumerHandoffResult,
} from '../local/handoff.js';
import { LocalRegistryError } from '../local/registry.js';
import {
  PHASE6_BID_ASK_MAPPING,
  PHASE6_CANONICAL_SOURCE_ORDER_SEMANTICS,
  PHASE6_CANONICAL_TIMESTAMP_SEMANTICS,
  PHASE6_INPUT_BINDING_SCHEMA_VERSION,
  PHASE6_MT5_ORDER_POLICY,
  PHASE6_MT5_PROFILE_ID,
  PHASE6_SAME_TIMESTAMP_POLICY,
  PHASE6_VOLUME_MAPPING_POLICY,
  type Phase6InputBinding,
} from './authority-contract.js';
import {
  assertConst,
  assertHandoffAuthority,
  assertMt5Columns,
  assertMt5Mapping,
  assertUtc,
  compareCommonBinding,
  compareDailyCanonicalIdentity,
  compareHandoffReferences,
  intField,
  object,
  p6Error,
  parseFileBindings,
  rowCount,
  shaField,
  stringField,
} from './authority-validate.js';

export function bindPhase6AcceptedInput(
  handoff: LocalConsumerHandoffResult,
  manifestRaw: unknown,
  numbaRaw: unknown,
  mt5Raw: unknown,
): Phase6InputBinding {
  const manifest = object(manifestRaw, 'manifest.json');
  const numba = object(numbaRaw, 'numba/dataset.json');
  const mt5 = object(mt5Raw, 'mt5/symbol_contract.json');

  assertConst(manifest.manifest_schema_version, '0.1.0', 'manifest.json.manifest_schema_version');
  assertConst(manifest.canonical_schema_version, '0.1', 'manifest.json.canonical_schema_version');
  assertConst(manifest.precision_status, 'VERIFIED', 'manifest.json.precision_status');
  assertConst(manifest.integrity_status, 'PASS', 'manifest.json.integrity_status');
  assertConst(manifest.canonical_promotion_allowed, true, 'manifest.json.canonical_promotion_allowed');

  const datasetId = stringField(manifest, 'dataset_id', 'manifest.json');
  if (!/^HDH_DATASET_V1_[0-9a-f]{64}$/.test(datasetId)) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', 'manifest.json.dataset_id is not an accepted dataset identity');
  }
  const symbol = stringField(manifest, 'symbol', 'manifest.json');
  const requestedFromUtc = stringField(manifest, 'requested_from_utc', 'manifest.json');
  const requestedToUtc = stringField(manifest, 'requested_to_utc', 'manifest.json');
  assertUtc(requestedFromUtc, 'manifest.json.requested_from_utc');
  assertUtc(requestedToUtc, 'manifest.json.requested_to_utc');
  const tickCountTotal = intField(manifest, 'tick_count_total', 'manifest.json');
  const sourceHashRoot = shaField(manifest, 'source_hash_root', 'manifest.json');
  const canonicalLogicalHashRoot = shaField(manifest, 'canonical_logical_hash_root', 'manifest.json');
  const parquetFileHashRoot = shaField(manifest, 'parquet_file_hash_root', 'manifest.json');
  const mt5DerivativeHashRoot = shaField(manifest, 'mt5_derivative_hash_root', 'manifest.json');
  const priceDigits = intField(manifest, 'price_digits', 'manifest.json');
  const priceScale = intField(manifest, 'price_scale', 'manifest.json', 1);

  assertHandoffAuthority(handoff, manifest);
  compareCommonBinding(numba, manifest, 'numba/dataset.json');
  compareCommonBinding(mt5, manifest, 'mt5/symbol_contract.json');

  const parquetBindings = parseFileBindings(numba.parquet_files, 'numba/dataset.json.parquet_files');
  const tickBindings = parseFileBindings(mt5.tick_files, 'mt5/symbol_contract.json.tick_files');
  compareDailyCanonicalIdentity(parquetBindings, tickBindings);
  const numbaRowCount = rowCount(parquetBindings);
  const mt5RowCount = rowCount(tickBindings);
  assertConst(numbaRowCount, tickCountTotal, 'Numba accepted row_count_total');
  assertConst(mt5RowCount, tickCountTotal, 'MT5 accepted row_count_total');

  assertConst(mt5.profile_id, PHASE6_MT5_PROFILE_ID, 'mt5/symbol_contract.json.profile_id');
  const csvColumns = assertMt5Columns(mt5);
  const mqltickMapping = assertMt5Mapping(mt5);
  assertConst(mt5.order_policy, PHASE6_MT5_ORDER_POLICY, 'mt5/symbol_contract.json.order_policy');
  assertConst(mt5.same_timestamp_policy, PHASE6_SAME_TIMESTAMP_POLICY, 'mt5/symbol_contract.json.same_timestamp_policy');
  assertConst(mt5.dedupe_applied, false, 'mt5/symbol_contract.json.dedupe_applied');
  assertConst(mt5.gap_fill_applied, false, 'mt5/symbol_contract.json.gap_fill_applied');
  assertConst(mt5.bid_ask_mapping, PHASE6_BID_ASK_MAPPING, 'mt5/symbol_contract.json.bid_ask_mapping');
  assertConst(mt5.volume_mapping_policy, PHASE6_VOLUME_MAPPING_POLICY, 'mt5/symbol_contract.json.volume_mapping_policy');

  const numbaFiles = compareHandoffReferences(handoff.numba.canonical_parquet_files, parquetBindings, 'numba.parquet_files');
  const mt5Files = compareHandoffReferences(handoff.mt5.tick_files, tickBindings, 'mt5.tick_files');

  return {
    input_binding_schema_version: PHASE6_INPUT_BINDING_SCHEMA_VERSION,
    binding_status: 'PASS',
    handoff_schema_version: LOCAL_HANDOFF_SCHEMA_VERSION,
    registry_schema_version: handoff.registry.registry_schema_version,
    dataset_id: datasetId,
    symbol,
    requested_from_utc: requestedFromUtc,
    requested_to_utc: requestedToUtc,
    tick_count_total: tickCountTotal,
    source_hash_root: sourceHashRoot,
    canonical_logical_hash_root: canonicalLogicalHashRoot,
    parquet_file_hash_root: parquetFileHashRoot,
    mt5_derivative_hash_root: mt5DerivativeHashRoot,
    price_digits: priceDigits,
    price_scale: priceScale,
    canonical_contract: {
      timestamp_field: 'timestamp_msc',
      timestamp_semantics: PHASE6_CANONICAL_TIMESTAMP_SEMANTICS,
      source_order_field: 'source_seq',
      source_order_semantics: PHASE6_CANONICAL_SOURCE_ORDER_SEMANTICS,
      exact_price_fields: ['bid_scaled', 'ask_scaled'],
      same_timestamp_policy: PHASE6_SAME_TIMESTAMP_POLICY,
    },
    packet_integrity: {
      integrity_status: 'PASS',
      canonical_promotion_allowed: true,
      registry_verify_status: 'PASS',
      packet_revalidation_status: 'PASS',
      manifest_sha256: handoff.authority.manifest_sha256,
      sha256sums_sha256: handoff.authority.sha256sums_sha256,
    },
    local_paths: {
      data_packet: handoff.local_packet_path,
      numba_dataset_json: handoff.numba.dataset_json_path,
      mt5_symbol_contract_json: handoff.mt5.symbol_contract_path,
    },
    numba: {
      dataset_binding_status: 'BOUND_P2_5_PACKET',
      canonical_schema_version: '0.1',
      file_count: numbaFiles.length,
      row_count_total: numbaRowCount,
      parquet_files: numbaFiles,
    },
    mt5: {
      dataset_binding_status: 'BOUND_P2_5_PACKET',
      canonical_schema_version: '0.1',
      profile_id: PHASE6_MT5_PROFILE_ID,
      csv_columns: csvColumns,
      mqltick_mapping: mqltickMapping,
      order_policy: PHASE6_MT5_ORDER_POLICY,
      same_timestamp_policy: PHASE6_SAME_TIMESTAMP_POLICY,
      dedupe_applied: false,
      gap_fill_applied: false,
      bid_ask_mapping: PHASE6_BID_ASK_MAPPING,
      volume_mapping_policy: PHASE6_VOLUME_MAPPING_POLICY,
      file_count: mt5Files.length,
      row_count_total: mt5RowCount,
      tick_files: mt5Files,
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

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (cause) {
    p6Error(
      'P6_INPUT_CONTRACT_UNSUPPORTED',
      'HOLD',
      `${label} could not be read as accepted JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function buildPhase6InputBinding(localRoot: string, datasetId: string): Promise<Phase6InputBinding> {
  let handoff: LocalConsumerHandoffResult;
  try {
    handoff = await buildLocalConsumerHandoff(localRoot, datasetId);
  } catch (cause) {
    if (cause instanceof LocalRegistryError && cause.code === 'DATASET_NOT_REGISTERED') {
      p6Error(
        'ACCEPTED_LOCAL_DATASET_UNAVAILABLE',
        'HOLD',
        `Accepted local dataset is unavailable through the Phase 5 registry: ${datasetId}`,
      );
    }
    throw cause;
  }
  const manifestPath = resolve(handoff.local_packet_path, 'manifest.json');
  const [manifest, numba, mt5] = await Promise.all([
    readJson(manifestPath, 'manifest.json'),
    readJson(handoff.numba.dataset_json_path, 'numba/dataset.json'),
    readJson(handoff.mt5.symbol_contract_path, 'mt5/symbol_contract.json'),
  ]);
  return bindPhase6AcceptedInput(handoff, manifest, numba, mt5);
}

import { LOCAL_HANDOFF_SCHEMA_VERSION, type LocalConsumerFileReference, type LocalConsumerHandoffResult } from '../local/handoff.js';
import {
  PHASE6_BID_ASK_MAPPING,
  PHASE6_MT5_CSV_COLUMNS,
  PHASE6_MT5_ORDER_POLICY,
  PHASE6_MT5_PROFILE_ID,
  PHASE6_SAME_TIMESTAMP_POLICY,
  PHASE6_VOLUME_MAPPING_POLICY,
  Phase6InputBindingError,
  type Phase6AuthorityFileBinding,
  type Phase6InputBinding,
  type Phase6InputBindingFailureCode,
} from './authority-contract.js';

export interface ParsedFileBinding {
  date_utc: string;
  path: string;
  physical_sha256: string;
  canonical_logical_row_hash: string;
  source_snapshot_sha256: string;
  row_count: number;
  file_size_bytes: number;
}

export function p6Error(code: Phase6InputBindingFailureCode, status: 'FAIL' | 'HOLD', message: string): never {
  throw new Phase6InputBindingError(code, status, message);
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be a non-empty string`);
  }
  return field;
}

export function shaField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  if (!/^[0-9a-f]{64}$/.test(field)) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be an accepted SHA-256 value`);
  }
  return field;
}

export function intField(value: Record<string, unknown>, key: string, label: string, minimum = 0): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < minimum) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label}.${key} must be an integer >= ${minimum}`);
  }
  return field as number;
}

export function assertConst(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    p6Error('P6_INPUT_BINDING_MISMATCH', 'HOLD', `${label} no longer matches frozen accepted authority`);
  }
}

export function assertUtc(value: string, label: string): void {
  if (!value.endsWith('Z') || !Number.isFinite(Date.parse(value))) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label} must remain an ISO UTC timestamp`);
  }
}

export function parseFileBindings(raw: unknown, label: string): ParsedFileBinding[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label} must remain a non-empty binding array`);
  }
  return raw.map((item, index) => {
    const value = object(item, `${label}[${index}]`);
    const dateUtc = stringField(value, 'date_utc', `${label}[${index}]`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) {
      p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', `${label}[${index}].date_utc is invalid`);
    }
    return {
      date_utc: dateUtc,
      path: stringField(value, 'path', `${label}[${index}]`),
      physical_sha256: shaField(value, 'physical_sha256', `${label}[${index}]`),
      canonical_logical_row_hash: shaField(value, 'canonical_logical_row_hash', `${label}[${index}]`),
      source_snapshot_sha256: shaField(value, 'source_snapshot_sha256', `${label}[${index}]`),
      row_count: intField(value, 'row_count', `${label}[${index}]`),
      file_size_bytes: intField(value, 'file_size_bytes', `${label}[${index}]`, 1),
    };
  });
}

export function compareCommonBinding(
  value: Record<string, unknown>,
  manifest: Record<string, unknown>,
  label: string,
): void {
  assertConst(value.schema_version, '0.1.0', `${label}.schema_version`);
  assertConst(value.dataset_binding_status, 'BOUND_P2_5_PACKET', `${label}.dataset_binding_status`);
  assertConst(value.canonical_schema_version, '0.1', `${label}.canonical_schema_version`);
  for (const key of [
    'dataset_id',
    'symbol',
    'requested_from_utc',
    'requested_to_utc',
    'source_hash_root',
    'canonical_logical_hash_root',
    'price_digits',
    'price_scale',
  ] as const) {
    assertConst(value[key], manifest[key], `${label}.${key}`);
  }
}

export function compareDailyCanonicalIdentity(numba: ParsedFileBinding[], mt5: ParsedFileBinding[]): void {
  if (numba.length !== mt5.length) {
    p6Error('P6_INPUT_BINDING_MISMATCH', 'HOLD', 'Numba/MT5 accepted daily binding counts differ');
  }
  for (let index = 0; index < numba.length; index += 1) {
    const left = numba[index]!;
    const right = mt5[index]!;
    for (const key of ['date_utc', 'canonical_logical_row_hash', 'source_snapshot_sha256', 'row_count'] as const) {
      if (left[key] !== right[key]) {
        p6Error(
          'P6_INPUT_BINDING_MISMATCH',
          'HOLD',
          `Numba/MT5 accepted Canonical identity diverges at binding index ${index}: ${key}`,
        );
      }
    }
  }
}

export function compareHandoffReferences(
  references: LocalConsumerFileReference[],
  bindings: ParsedFileBinding[],
  label: string,
): Phase6AuthorityFileBinding[] {
  if (references.length !== bindings.length) {
    p6Error('P6_INPUT_BINDING_MISMATCH', 'HOLD', `${label} handoff reference count changed`);
  }
  return bindings.map((binding, index) => {
    const ref = references[index]!;
    const expected: Record<string, string | number> = {
      date_utc: binding.date_utc,
      packet_relative_path: binding.path,
      physical_sha256: binding.physical_sha256,
      canonical_logical_row_hash: binding.canonical_logical_row_hash,
      source_snapshot_sha256: binding.source_snapshot_sha256,
      row_count: binding.row_count,
      file_size_bytes: binding.file_size_bytes,
    };
    for (const [key, expectedValue] of Object.entries(expected)) {
      if ((ref as unknown as Record<string, unknown>)[key] !== expectedValue) {
        p6Error('P6_INPUT_BINDING_MISMATCH', 'HOLD', `${label}[${index}].${key} changed after Phase 5 handoff`);
      }
    }
    return {
      date_utc: ref.date_utc,
      packet_relative_path: ref.packet_relative_path,
      local_path: ref.local_path,
      physical_sha256: ref.physical_sha256,
      canonical_logical_row_hash: ref.canonical_logical_row_hash,
      source_snapshot_sha256: ref.source_snapshot_sha256,
      row_count: ref.row_count,
      file_size_bytes: ref.file_size_bytes,
    };
  });
}

export function rowCount(bindings: ParsedFileBinding[]): number {
  const total = bindings.reduce((sum, item) => sum + item.row_count, 0);
  if (!Number.isSafeInteger(total)) {
    p6Error('P6_INPUT_CONTRACT_UNSUPPORTED', 'HOLD', 'Accepted binding row count total exceeds safe integer range');
  }
  return total;
}

export function assertMt5Mapping(value: Record<string, unknown>): Phase6InputBinding['mt5']['mqltick_mapping'] {
  const raw = object(value.mqltick_mapping, 'mt5/symbol_contract.json.mqltick_mapping');
  const expected = {
    time: 'floor(time_msc/1000)',
    time_msc: 'DIRECT',
    bid: 'DIRECT_CANONICAL_PRICE',
    ask: 'DIRECT_CANONICAL_PRICE',
    last: '0',
    volume: '0',
    volume_real: '0',
    flags: 'TICK_FLAG_BID|TICK_FLAG_ASK',
  } as const;
  for (const [key, expectedValue] of Object.entries(expected)) {
    assertConst(raw[key], expectedValue, `mt5/symbol_contract.json.mqltick_mapping.${key}`);
  }
  return expected;
}

export function assertMt5Columns(value: Record<string, unknown>): typeof PHASE6_MT5_CSV_COLUMNS {
  const raw = value.csv_columns;
  if (!Array.isArray(raw) || raw.length !== PHASE6_MT5_CSV_COLUMNS.length) {
    p6Error('P6_INPUT_BINDING_MISMATCH', 'HOLD', 'mt5/symbol_contract.json.csv_columns changed');
  }
  for (let index = 0; index < PHASE6_MT5_CSV_COLUMNS.length; index += 1) {
    assertConst(raw[index], PHASE6_MT5_CSV_COLUMNS[index], `mt5/symbol_contract.json.csv_columns[${index}]`);
  }
  return PHASE6_MT5_CSV_COLUMNS;
}

export function assertHandoffAuthority(handoff: LocalConsumerHandoffResult, manifest: Record<string, unknown>): void {
  assertConst(handoff.handoff_schema_version, LOCAL_HANDOFF_SCHEMA_VERSION, 'handoff_schema_version');
  assertConst(handoff.handoff_status, 'PASS', 'handoff_status');
  assertConst(handoff.registry.registry_verify_status, 'PASS', 'registry.registry_verify_status');
  assertConst(handoff.registry.packet_revalidation_status, 'PASS', 'registry.packet_revalidation_status');
  assertConst(handoff.packet_mutation_performed, false, 'packet_mutation_performed');
  assertConst(handoff.registry_mutation_performed, false, 'registry_mutation_performed');
  assertConst(handoff.terminal_mt5_mutation_performed, false, 'terminal_mt5_mutation_performed');
  assertConst(handoff.strategy_evaluation_performed, false, 'strategy_evaluation_performed');
  assertConst(handoff.numba_mt5_parity_declared, false, 'numba_mt5_parity_declared');

  const row = handoff.registry.dataset;
  for (const key of ['dataset_id', 'symbol', 'requested_from_utc', 'requested_to_utc'] as const) {
    assertConst(handoff[key], manifest[key], `handoff.${key}`);
    assertConst(row[key], manifest[key], `registry.dataset.${key}`);
  }
  for (const key of ['source_hash_root', 'canonical_logical_hash_root', 'parquet_file_hash_root', 'mt5_derivative_hash_root'] as const) {
    assertConst(handoff.authority[key], manifest[key], `handoff.authority.${key}`);
    assertConst(row[key], manifest[key], `registry.dataset.${key}`);
  }
  assertConst(row.tick_count_total, manifest.tick_count_total, 'registry.dataset.tick_count_total');
  assertConst(row.integrity_status, 'PASS', 'registry.dataset.integrity_status');
  assertConst(row.canonical_promotion_allowed, true, 'registry.dataset.canonical_promotion_allowed');
  assertConst(handoff.authority.manifest_sha256, row.manifest_sha256, 'handoff.authority.manifest_sha256');
  assertConst(handoff.authority.sha256sums_sha256, row.sha256sums_sha256, 'handoff.authority.sha256sums_sha256');
}

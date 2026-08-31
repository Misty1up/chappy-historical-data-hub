import { createHash } from 'node:crypto';
import {
  PHASE6_INPUT_BINDING_SCHEMA_VERSION,
  type Phase6InputBinding,
} from './authority-contract.js';

export const PHASE6_PARITY_RUN_SPEC_SCHEMA_VERSION = 'HDH_P6_PARITY_RUN_SPEC_V1' as const;
export const PHASE6_PARITY_CONTRACT_VERSION = '0.1' as const;
export const PHASE6_PARITY_RUN_ID_PREFIX = 'HDH_P6_RUN_V1_' as const;

export type Phase6RunContractFailureCode = 'P6_RUN_CONTRACT_INVALID';

export class Phase6RunContractError extends Error {
  constructor(
    public readonly code: Phase6RunContractFailureCode,
    public readonly status: 'HOLD',
    message: string,
  ) {
    super(message);
    this.name = 'Phase6RunContractError';
  }
}

export interface Phase6RunContractConfig {
  repository_commit: string;
  numba_adapter_version: string;
  mt5_adapter_version: string;
  logic_contract_id: string;
  logic_contract_sha256: string;
  comparator_profile_id: string;
  comparator_profile_sha256: string;
  environment_versions: Record<string, string>;
  output_evidence_root: string;
}

export interface Phase6ParityRunSpec {
  parity_run_spec_schema_version: typeof PHASE6_PARITY_RUN_SPEC_SCHEMA_VERSION;
  parity_contract_version: typeof PHASE6_PARITY_CONTRACT_VERSION;
  parity_run_id: string;
  run_spec_status: 'BOUND';
  input_binding_schema_version: typeof PHASE6_INPUT_BINDING_SCHEMA_VERSION;
  dataset_id: string;
  source_hash_root: string;
  canonical_logical_hash_root: string;
  parquet_file_hash_root: string;
  mt5_derivative_hash_root: string;
  tick_count_total: number;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  price_digits: number;
  price_scale: number;
  timestamp_semantics: Phase6InputBinding['canonical_contract']['timestamp_semantics'];
  source_order_semantics: Phase6InputBinding['canonical_contract']['source_order_semantics'];
  same_timestamp_policy: Phase6InputBinding['canonical_contract']['same_timestamp_policy'];
  mt5_profile_id: Phase6InputBinding['mt5']['profile_id'];
  mt5_order_policy: Phase6InputBinding['mt5']['order_policy'];
  bid_ask_mapping: Phase6InputBinding['mt5']['bid_ask_mapping'];
  volume_mapping_policy: Phase6InputBinding['mt5']['volume_mapping_policy'];
  repository_commit: string;
  numba_adapter_version: string;
  mt5_adapter_version: string;
  logic_contract_id: string;
  logic_contract_sha256: string;
  comparator_profile_id: string;
  comparator_profile_sha256: string;
  environment_versions: Record<string, string>;
  output_evidence_root: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function runError(message: string): never {
  throw new Phase6RunContractError('P6_RUN_CONTRACT_INVALID', 'HOLD', message);
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) runError(`${label} must be a non-empty string`);
  return value;
}

function sha(value: string, label: string): string {
  nonEmpty(value, label);
  if (!/^[0-9a-f]{64}$/.test(value)) runError(`${label} must be a lowercase SHA-256 value`);
  return value;
}

function repositoryCommit(value: string): string {
  nonEmpty(value, 'repository_commit');
  if (!/^[0-9a-f]{40}$/.test(value)) runError('repository_commit must be an exact 40-hex Git commit');
  return value;
}

function environmentVersions(value: Record<string, string>): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    runError('environment_versions must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) runError('environment_versions must declare at least one version');
  const output: Record<string, string> = {};
  for (const [key, version] of entries) {
    nonEmpty(key, 'environment_versions key');
    output[key] = nonEmpty(version, `environment_versions.${key}`);
  }
  return output;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) runError(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = jsonValue((value as Record<string, unknown>)[key], `${label}.${key}`);
    }
    return output;
  }
  runError(`${label} contains a non-JSON value`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, 'run contract'));
}

function calculateRunId(bound: Omit<Phase6ParityRunSpec, 'parity_run_id'>): string {
  const digest = createHash('sha256').update(stableJson(bound), 'utf8').digest('hex');
  return `${PHASE6_PARITY_RUN_ID_PREFIX}${digest}`;
}

function assertAuthorityBinding(input: Phase6InputBinding): void {
  if (input.input_binding_schema_version !== PHASE6_INPUT_BINDING_SCHEMA_VERSION || input.binding_status !== 'PASS') {
    runError('Phase 6 run requires a PASS HDH_P6_INPUT_BINDING_V1 input binding');
  }
  if (!/^HDH_DATASET_V1_[0-9a-f]{64}$/.test(input.dataset_id)) runError('input binding dataset_id is invalid');
  for (const [label, value] of [
    ['source_hash_root', input.source_hash_root],
    ['canonical_logical_hash_root', input.canonical_logical_hash_root],
    ['parquet_file_hash_root', input.parquet_file_hash_root],
    ['mt5_derivative_hash_root', input.mt5_derivative_hash_root],
  ] as const) sha(value, `input binding ${label}`);
  if (!Number.isSafeInteger(input.tick_count_total) || input.tick_count_total < 0) runError('input binding tick_count_total is invalid');
  if (!Number.isSafeInteger(input.price_digits) || input.price_digits < 0) runError('input binding price_digits is invalid');
  if (!Number.isSafeInteger(input.price_scale) || input.price_scale < 1) runError('input binding price_scale is invalid');
  nonEmpty(input.symbol, 'input binding symbol');
  for (const [label, timestamp] of [
    ['requested_from_utc', input.requested_from_utc],
    ['requested_to_utc', input.requested_to_utc],
  ] as const) {
    if (!timestamp.endsWith('Z') || !Number.isFinite(Date.parse(timestamp))) runError(`input binding ${label} is not UTC`);
  }
}

export function createPhase6ParityRunSpec(
  input: Phase6InputBinding,
  config: Phase6RunContractConfig,
): Phase6ParityRunSpec {
  assertAuthorityBinding(input);
  const env = environmentVersions(config.environment_versions);
  const bound: Omit<Phase6ParityRunSpec, 'parity_run_id'> = {
    parity_run_spec_schema_version: PHASE6_PARITY_RUN_SPEC_SCHEMA_VERSION,
    parity_contract_version: PHASE6_PARITY_CONTRACT_VERSION,
    run_spec_status: 'BOUND',
    input_binding_schema_version: PHASE6_INPUT_BINDING_SCHEMA_VERSION,
    dataset_id: input.dataset_id,
    source_hash_root: input.source_hash_root,
    canonical_logical_hash_root: input.canonical_logical_hash_root,
    parquet_file_hash_root: input.parquet_file_hash_root,
    mt5_derivative_hash_root: input.mt5_derivative_hash_root,
    tick_count_total: input.tick_count_total,
    symbol: input.symbol,
    requested_from_utc: input.requested_from_utc,
    requested_to_utc: input.requested_to_utc,
    price_digits: input.price_digits,
    price_scale: input.price_scale,
    timestamp_semantics: input.canonical_contract.timestamp_semantics,
    source_order_semantics: input.canonical_contract.source_order_semantics,
    same_timestamp_policy: input.canonical_contract.same_timestamp_policy,
    mt5_profile_id: input.mt5.profile_id,
    mt5_order_policy: input.mt5.order_policy,
    bid_ask_mapping: input.mt5.bid_ask_mapping,
    volume_mapping_policy: input.mt5.volume_mapping_policy,
    repository_commit: repositoryCommit(config.repository_commit),
    numba_adapter_version: nonEmpty(config.numba_adapter_version, 'numba_adapter_version'),
    mt5_adapter_version: nonEmpty(config.mt5_adapter_version, 'mt5_adapter_version'),
    logic_contract_id: nonEmpty(config.logic_contract_id, 'logic_contract_id'),
    logic_contract_sha256: sha(config.logic_contract_sha256, 'logic_contract_sha256'),
    comparator_profile_id: nonEmpty(config.comparator_profile_id, 'comparator_profile_id'),
    comparator_profile_sha256: sha(config.comparator_profile_sha256, 'comparator_profile_sha256'),
    environment_versions: env,
    output_evidence_root: nonEmpty(config.output_evidence_root, 'output_evidence_root'),
  };
  return { ...bound, parity_run_id: calculateRunId(bound) };
}

export function validatePhase6ParityRunSpec(spec: Phase6ParityRunSpec): void {
  if (spec.parity_run_spec_schema_version !== PHASE6_PARITY_RUN_SPEC_SCHEMA_VERSION) {
    runError('parity_run_spec_schema_version is unsupported');
  }
  if (spec.parity_contract_version !== PHASE6_PARITY_CONTRACT_VERSION) {
    runError('parity_contract_version is unsupported');
  }
  if (spec.run_spec_status !== 'BOUND') runError('run_spec_status must remain BOUND');
  const { parity_run_id: parityRunId, ...bound } = spec;
  const expected = calculateRunId(bound);
  if (parityRunId !== expected) runError('parity_run_id does not match the immutable bound run contract');
}

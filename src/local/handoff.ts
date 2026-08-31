import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  LocalRegistryError,
  type LocalRegistryDatasetRow,
  type LocalRegistryVerifyResult,
  verifyRegisteredDataset,
} from './registry.js';

export const LOCAL_HANDOFF_SCHEMA_VERSION = 'HDH_LOCAL_HANDOFF_V1';

export type LocalHandoffFailureCode =
  | 'LOCAL_HANDOFF_INCONSISTENT'
  | 'HANDOFF_PACKET_CHANGED';

export class LocalHandoffError extends Error {
  constructor(
    public readonly code: LocalHandoffFailureCode,
    public readonly status: 'FAIL' | 'HOLD',
    message: string,
  ) {
    super(message);
    this.name = 'LocalHandoffError';
  }
}

export interface LocalConsumerFileReference {
  date_utc: string;
  packet_relative_path: string;
  local_path: string;
  physical_sha256: string;
  canonical_logical_row_hash: string;
  source_snapshot_sha256: string;
  row_count: number;
  file_size_bytes: number;
}

export interface LocalConsumerHandoffResult {
  handoff_schema_version: typeof LOCAL_HANDOFF_SCHEMA_VERSION;
  handoff_status: 'PASS';
  dataset_id: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  local_packet_path: string;
  authority: {
    source_hash_root: string;
    canonical_logical_hash_root: string;
    parquet_file_hash_root: string;
    mt5_derivative_hash_root: string;
    manifest_sha256: string;
    sha256sums_sha256: string;
  };
  registry: {
    registry_schema_version: string;
    registry_verify_status: 'PASS';
    packet_revalidation_status: 'PASS';
    dataset: LocalRegistryDatasetRow;
  };
  numba: {
    dataset_json_path: string;
    canonical_parquet_files: LocalConsumerFileReference[];
    handoff_description: string;
  };
  mt5: {
    symbol_contract_path: string;
    tick_root_path: string;
    tick_symbol_path: string;
    tick_files: LocalConsumerFileReference[];
    handoff_description: string;
  };
  packet_mutation_performed: false;
  registry_mutation_performed: false;
  terminal_mt5_mutation_performed: false;
  strategy_evaluation_performed: false;
  numba_mt5_parity_declared: false;
}

interface RawFileBinding {
  date_utc: string;
  path: string;
  physical_sha256: string;
  file_size_bytes: number;
  canonical_logical_row_hash: string;
  row_count: number;
  source_snapshot_sha256: string;
}

function handoffError(code: LocalHandoffFailureCode, status: 'FAIL' | 'HOLD', message: string): never {
  throw new LocalHandoffError(code, status, message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label} must remain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label}.${key} must remain a non-empty string`);
  }
  return field;
}

function intField(value: Record<string, unknown>, key: string, label: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label}.${key} must remain a non-negative integer`);
  }
  return field as number;
}

function shaField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  if (!/^[0-9a-f]{64}$/.test(field)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label}.${key} must remain an accepted SHA-256 value`);
  }
  return field;
}

function assertCommonAuthority(
  value: Record<string, unknown>,
  row: LocalRegistryDatasetRow,
  label: string,
): void {
  const expected: Record<string, string> = {
    dataset_id: row.dataset_id,
    symbol: row.symbol,
    requested_from_utc: row.requested_from_utc,
    requested_to_utc: row.requested_to_utc,
    source_hash_root: row.source_hash_root,
    canonical_logical_hash_root: row.canonical_logical_hash_root,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      handoffError(
        'LOCAL_HANDOFF_INCONSISTENT',
        'HOLD',
        `${label}.${key} no longer matches the verified registry/Packet authority`,
      );
    }
  }
  if (value.dataset_binding_status !== 'BOUND_P2_5_PACKET') {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label}.dataset_binding_status is not accepted`);
  }
}

function binding(raw: unknown, label: string): RawFileBinding {
  const value = object(raw, label);
  const dateUtc = stringField(value, 'date_utc', label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label}.date_utc is invalid`);
  }
  return {
    date_utc: dateUtc,
    path: stringField(value, 'path', label),
    physical_sha256: shaField(value, 'physical_sha256', label),
    file_size_bytes: intField(value, 'file_size_bytes', label),
    canonical_logical_row_hash: shaField(value, 'canonical_logical_row_hash', label),
    row_count: intField(value, 'row_count', label),
    source_snapshot_sha256: shaField(value, 'source_snapshot_sha256', label),
  };
}

function bindingArray(value: Record<string, unknown>, key: string, label: string): RawFileBinding[] {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label}.${key} must remain a non-empty binding array`);
  }
  return raw.map((item, index) => binding(item, `${label}.${key}[${index}]`));
}

function safeRelativePath(relativePath: string, expectedPrefix: string, label: string): void {
  if (
    !relativePath
    || isAbsolute(relativePath)
    || relativePath.startsWith('/')
    || relativePath.startsWith('\\')
    || relativePath.includes('\\')
    || /^[A-Za-z]:/.test(relativePath)
  ) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label} is not an accepted Packet-relative path`);
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label} contains unsafe path segments`);
  }
  if (!relativePath.startsWith(expectedPrefix)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label} is outside its accepted Packet subtree`);
  }
}

function assertContained(packetRoot: string, candidate: string, label: string): void {
  const back = relative(resolve(packetRoot), resolve(candidate));
  if (!back || back === '.' || back === '..' || back.startsWith('../') || back.startsWith('..\\') || isAbsolute(back)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label} escapes the verified DATA_PACKET`);
  }
}

async function ordinaryPacketFile(
  packetRoot: string,
  relativePath: string,
  expectedPrefix: string,
  label: string,
): Promise<string> {
  safeRelativePath(relativePath, expectedPrefix, label);
  const absolute = resolve(packetRoot, relativePath);
  assertContained(packetRoot, absolute, label);
  const entry = await lstat(absolute).catch(cause => {
    handoffError(
      'HANDOFF_PACKET_CHANGED',
      'HOLD',
      `${label} disappeared after Packet verification: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  });
  if (entry.isSymbolicLink() || !entry.isFile()) {
    handoffError('HANDOFF_PACKET_CHANGED', 'HOLD', `${label} is no longer an ordinary verified file`);
  }
  return absolute;
}

async function ordinaryPacketDirectory(packetRoot: string, relativePath: string, label: string): Promise<string> {
  safeRelativePath(`${relativePath}/placeholder`, `${relativePath}/`, label);
  const absolute = resolve(packetRoot, relativePath);
  assertContained(packetRoot, absolute, label);
  const entry = await lstat(absolute).catch(cause => {
    handoffError(
      'HANDOFF_PACKET_CHANGED',
      'HOLD',
      `${label} disappeared after Packet verification: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  });
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    handoffError('HANDOFF_PACKET_CHANGED', 'HOLD', `${label} is no longer an ordinary verified directory`);
  }
  return absolute;
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  try {
    return object(JSON.parse(await readFile(path, 'utf8')) as unknown, label);
  } catch (cause) {
    if (cause instanceof LocalHandoffError) throw cause;
    handoffError(
      'HANDOFF_PACKET_CHANGED',
      'HOLD',
      `${label} could not be read after Packet verification: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function references(
  packetRoot: string,
  bindings: RawFileBinding[],
  expectedPrefix: string,
  label: string,
): Promise<LocalConsumerFileReference[]> {
  const seen = new Set<string>();
  const output: LocalConsumerFileReference[] = [];
  for (let index = 0; index < bindings.length; index += 1) {
    const item = bindings[index]!;
    if (seen.has(item.path)) {
      handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', `${label} contains duplicate Packet path: ${item.path}`);
    }
    seen.add(item.path);
    output.push({
      date_utc: item.date_utc,
      packet_relative_path: item.path,
      local_path: await ordinaryPacketFile(packetRoot, item.path, expectedPrefix, `${label}[${index}].path`),
      physical_sha256: item.physical_sha256,
      canonical_logical_row_hash: item.canonical_logical_row_hash,
      source_snapshot_sha256: item.source_snapshot_sha256,
      row_count: item.row_count,
      file_size_bytes: item.file_size_bytes,
    });
  }
  return output;
}

function requireAcceptedRoots(row: LocalRegistryDatasetRow): { parquet: string; mt5: string } {
  if (!row.parquet_file_hash_root || !/^[0-9a-f]{64}$/.test(row.parquet_file_hash_root)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', 'Registered accepted Packet lacks parquet_file_hash_root');
  }
  if (!row.mt5_derivative_hash_root || !/^[0-9a-f]{64}$/.test(row.mt5_derivative_hash_root)) {
    handoffError('LOCAL_HANDOFF_INCONSISTENT', 'HOLD', 'Registered accepted Packet lacks mt5_derivative_hash_root');
  }
  return { parquet: row.parquet_file_hash_root, mt5: row.mt5_derivative_hash_root };
}

function assertStableVerification(before: LocalRegistryVerifyResult, after: LocalRegistryVerifyResult): void {
  if (
    before.dataset.dataset_id !== after.dataset.dataset_id
    || before.dataset.local_packet_path !== after.dataset.local_packet_path
    || before.dataset.manifest_sha256 !== after.dataset.manifest_sha256
    || before.dataset.sha256sums_sha256 !== after.dataset.sha256sums_sha256
    || before.dataset.source_hash_root !== after.dataset.source_hash_root
    || before.dataset.canonical_logical_hash_root !== after.dataset.canonical_logical_hash_root
    || before.dataset.parquet_file_hash_root !== after.dataset.parquet_file_hash_root
    || before.dataset.mt5_derivative_hash_root !== after.dataset.mt5_derivative_hash_root
  ) {
    handoffError('HANDOFF_PACKET_CHANGED', 'HOLD', 'Registered DATA_PACKET authority changed while building handoff references');
  }
}

export async function buildLocalConsumerHandoff(
  localRoot: string,
  datasetId: string,
): Promise<LocalConsumerHandoffResult> {
  let before: LocalRegistryVerifyResult;
  try {
    before = await verifyRegisteredDataset(localRoot, datasetId);
  } catch (cause) {
    if (cause instanceof LocalRegistryError) throw cause;
    throw cause;
  }

  const row = before.dataset;
  const packetRoot = resolve(row.local_packet_path);
  const roots = requireAcceptedRoots(row);
  const numbaDatasetPath = await ordinaryPacketFile(packetRoot, 'numba/dataset.json', 'numba/', 'numba/dataset.json');
  const mt5ContractPath = await ordinaryPacketFile(packetRoot, 'mt5/symbol_contract.json', 'mt5/', 'mt5/symbol_contract.json');
  const numba = await readJsonObject(numbaDatasetPath, 'numba/dataset.json');
  const mt5 = await readJsonObject(mt5ContractPath, 'mt5/symbol_contract.json');
  assertCommonAuthority(numba, row, 'numba/dataset.json');
  assertCommonAuthority(mt5, row, 'mt5/symbol_contract.json');

  const parquetBindings = bindingArray(numba, 'parquet_files', 'numba/dataset.json');
  const tickBindings = bindingArray(mt5, 'tick_files', 'mt5/symbol_contract.json');
  const canonicalParquetFiles = await references(
    packetRoot,
    parquetBindings,
    `canonical/${row.symbol}/`,
    'numba.parquet_files',
  );
  const tickFiles = await references(
    packetRoot,
    tickBindings,
    `mt5/ticks/${row.symbol}/`,
    'mt5.tick_files',
  );
  const tickRootPath = await ordinaryPacketDirectory(packetRoot, 'mt5/ticks', 'mt5/ticks');
  const tickSymbolPath = await ordinaryPacketDirectory(packetRoot, `mt5/ticks/${row.symbol}`, `mt5/ticks/${row.symbol}`);

  const after = await verifyRegisteredDataset(localRoot, datasetId);
  assertStableVerification(before, after);

  return {
    handoff_schema_version: LOCAL_HANDOFF_SCHEMA_VERSION,
    handoff_status: 'PASS',
    dataset_id: row.dataset_id,
    symbol: row.symbol,
    requested_from_utc: row.requested_from_utc,
    requested_to_utc: row.requested_to_utc,
    local_packet_path: packetRoot,
    authority: {
      source_hash_root: row.source_hash_root,
      canonical_logical_hash_root: row.canonical_logical_hash_root,
      parquet_file_hash_root: roots.parquet,
      mt5_derivative_hash_root: roots.mt5,
      manifest_sha256: row.manifest_sha256,
      sha256sums_sha256: row.sha256sums_sha256,
    },
    registry: {
      registry_schema_version: before.registry_schema_version,
      registry_verify_status: 'PASS',
      packet_revalidation_status: 'PASS',
      dataset: row,
    },
    numba: {
      dataset_json_path: numbaDatasetPath,
      canonical_parquet_files: canonicalParquetFiles,
      handoff_description: 'Read only the accepted Packet-bound Canonical Parquet files. Phase 5 performs no aggregation, feature calculation, KPI calculation, re-normalization, or Numba validity declaration.',
    },
    mt5: {
      symbol_contract_path: mt5ContractPath,
      tick_root_path: tickRootPath,
      tick_symbol_path: tickSymbolPath,
      tick_files: tickFiles,
      handoff_description: 'Read only the accepted Packet-bound MT5 derivative files and symbol contract. Phase 5 performs no MT5 terminal/custom-symbol mutation, Strategy Tester execution, or parity declaration.',
    },
    packet_mutation_performed: false,
    registry_mutation_performed: false,
    terminal_mt5_mutation_performed: false,
    strategy_evaluation_performed: false,
    numba_mt5_parity_declared: false,
  };
}

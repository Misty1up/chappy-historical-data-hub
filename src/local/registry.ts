import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import initSqlJs, { type Database, type SqlJsValue } from 'sql.js';
import {
  installLocalDatasetPacketWithRegistryCoordination,
  type LocalInstallResult,
} from './installer.js';
import {
  LocalPacketError,
  scanLocalDatasetPacket,
  type LocalPacketScanResult,
} from './packet-verifier.js';

export const LOCAL_REGISTRY_SCHEMA_VERSION = 'HDH_LOCAL_REGISTRY_V1';

export type LocalRegistryFailureCode =
  | 'LOCAL_REGISTRY_INCONSISTENT'
  | 'REGISTRY_LOCKED'
  | 'REGISTRY_TRANSACTION_FAIL'
  | 'DATASET_NOT_REGISTERED';

export class LocalRegistryError extends Error {
  constructor(
    public readonly code: LocalRegistryFailureCode,
    public readonly status: 'FAIL' | 'HOLD',
    message: string,
    public readonly causeCode: string | null = null,
  ) {
    super(message);
    this.name = 'LocalRegistryError';
  }
}

export interface LocalRegistryDatasetRow {
  dataset_id: string;
  local_packet_path: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  tick_count_total: number | null;
  source_hash_root: string;
  canonical_logical_hash_root: string;
  parquet_file_hash_root: string | null;
  mt5_derivative_hash_root: string | null;
  integrity_status: string;
  canonical_promotion_allowed: boolean;
  manifest_sha256: string;
  sha256sums_sha256: string;
  import_status: 'IMPORTED';
  import_run_id: string;
  imported_at_utc: string;
  source_transport_type: 'DIRECTORY' | 'ZIP' | null;
  workflow_run_id: string | null;
  artifact_id: string | null;
  artifact_digest: string | null;
}

export interface LocalRegistryListResult {
  registry_schema_version: typeof LOCAL_REGISTRY_SCHEMA_VERSION;
  registry_file_status: 'NOT_PRESENT' | 'PRESENT';
  datasets: LocalRegistryDatasetRow[];
}

export interface LocalRegistryShowResult {
  registry_schema_version: typeof LOCAL_REGISTRY_SCHEMA_VERSION;
  dataset: LocalRegistryDatasetRow;
}

export interface LocalRegistryVerifyResult extends LocalRegistryShowResult {
  registry_verify_status: 'PASS';
  packet_revalidation_status: 'PASS';
}

export interface LocalRegistryMutationResult {
  local_import_status: 'IMPORTED' | 'ALREADY_REGISTERED';
  operation: 'IMPORT_REGISTER' | 'ADOPT_REGISTER';
  dataset_id: string;
  final_packet_path: string;
  filesystem_mutation_performed: boolean;
  registry_mutation_performed: boolean;
  import_run_id: string | null;
  registry_schema_version: typeof LOCAL_REGISTRY_SCHEMA_VERSION;
}

export interface LocalRegistryTestHooks {
  beforeCommit?: () => void;
  beforePersist?: () => Promise<void>;
}

const DATASET_ID_RE = /^HDH_DATASET_V1_[0-9a-f]{64}$/;
const sqlPromise = initSqlJs();

const DATASET_COLUMNS = [
  'dataset_id',
  'local_packet_path',
  'symbol',
  'requested_from_utc',
  'requested_to_utc',
  'tick_count_total',
  'source_hash_root',
  'canonical_logical_hash_root',
  'parquet_file_hash_root',
  'mt5_derivative_hash_root',
  'integrity_status',
  'canonical_promotion_allowed',
  'manifest_sha256',
  'sha256sums_sha256',
  'import_status',
  'import_run_id',
  'imported_at_utc',
  'source_transport_type',
  'workflow_run_id',
  'artifact_id',
  'artifact_digest',
] as const;

function registryError(
  code: LocalRegistryFailureCode,
  status: 'FAIL' | 'HOLD',
  message: string,
  causeCode: string | null = null,
): never {
  throw new LocalRegistryError(code, status, message, causeCode);
}

function isEnoent(value: unknown): boolean {
  return (value as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function assertDatasetId(datasetId: string): void {
  if (!DATASET_ID_RE.test(datasetId)) {
    registryError('LOCAL_REGISTRY_INCONSISTENT', 'FAIL', `Invalid accepted dataset_id syntax: ${datasetId}`);
  }
}

function expectedPacketPath(localRoot: string, datasetId: string): string {
  assertDatasetId(datasetId);
  const root = resolve(localRoot);
  const datasetsRoot = resolve(root, 'datasets');
  const packet = resolve(datasetsRoot, datasetId, 'DATA_PACKET');
  const back = relative(datasetsRoot, packet);
  if (!back || back === '.' || back === '..' || back.startsWith('../') || back.startsWith('..\\')) {
    registryError('LOCAL_REGISTRY_INCONSISTENT', 'HOLD', `Dataset path is not safely contained beneath local root: ${packet}`);
  }
  return packet;
}

function registryPaths(localRoot: string) {
  const root = resolve(localRoot);
  const directory = resolve(root, 'registry');
  return {
    root,
    directory,
    db: resolve(directory, 'hdh_registry.sqlite'),
    lock: resolve(directory, 'hdh_registry.lock'),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isEnoent(cause)) return false;
    throw cause;
  }
}

async function acquireRegistryLock(localRoot: string): Promise<{ close: () => Promise<void>; path: string }> {
  const paths = registryPaths(localRoot);
  await mkdir(paths.directory, { recursive: true });
  try {
    const handle = await open(paths.lock, 'wx');
    return {
      path: paths.lock,
      close: async () => {
        await handle.close().catch(() => undefined);
        await rm(paths.lock, { force: true }).catch(() => undefined);
      },
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      registryError('REGISTRY_LOCKED', 'HOLD', `Local registry is locked: ${paths.lock}`);
    }
    registryError(
      'REGISTRY_TRANSACTION_FAIL',
      'FAIL',
      `Could not acquire local registry lock: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS registry_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      dataset_id TEXT PRIMARY KEY NOT NULL,
      local_packet_path TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      requested_from_utc TEXT NOT NULL,
      requested_to_utc TEXT NOT NULL,
      tick_count_total INTEGER,
      source_hash_root TEXT NOT NULL,
      canonical_logical_hash_root TEXT NOT NULL,
      parquet_file_hash_root TEXT,
      mt5_derivative_hash_root TEXT,
      integrity_status TEXT NOT NULL,
      canonical_promotion_allowed INTEGER NOT NULL CHECK(canonical_promotion_allowed IN (0,1)),
      manifest_sha256 TEXT NOT NULL,
      sha256sums_sha256 TEXT NOT NULL,
      import_status TEXT NOT NULL CHECK(import_status = 'IMPORTED'),
      import_run_id TEXT NOT NULL,
      imported_at_utc TEXT NOT NULL,
      source_transport_type TEXT,
      workflow_run_id TEXT,
      artifact_id TEXT,
      artifact_digest TEXT
    );
  `);
  const meta = db.exec(`SELECT value FROM registry_meta WHERE key = 'schema_version'`);
  if (meta.length === 0 || meta[0]!.values.length === 0) {
    db.run(`INSERT INTO registry_meta(key, value) VALUES('schema_version', ?)`, [LOCAL_REGISTRY_SCHEMA_VERSION]);
  } else if (meta[0]!.values[0]![0] !== LOCAL_REGISTRY_SCHEMA_VERSION) {
    registryError(
      'LOCAL_REGISTRY_INCONSISTENT',
      'HOLD',
      `Unsupported registry schema version: ${String(meta[0]!.values[0]![0])}`,
    );
  }
}

function assertSchema(db: Database): void {
  try {
    const result = db.exec(`SELECT value FROM registry_meta WHERE key = 'schema_version'`);
    const version = result[0]?.values[0]?.[0];
    if (version !== LOCAL_REGISTRY_SCHEMA_VERSION) {
      registryError(
        'LOCAL_REGISTRY_INCONSISTENT',
        'HOLD',
        `Registry schema is missing or unsupported: ${String(version ?? 'null')}`,
      );
    }
    const columns = db.exec(`PRAGMA table_info(datasets)`);
    const actual = new Set((columns[0]?.values ?? []).map(row => String(row[1])));
    for (const column of DATASET_COLUMNS) {
      if (!actual.has(column)) {
        registryError('LOCAL_REGISTRY_INCONSISTENT', 'HOLD', `Registry datasets table is missing column: ${column}`);
      }
    }
  } catch (cause) {
    if (cause instanceof LocalRegistryError) throw cause;
    registryError(
      'LOCAL_REGISTRY_INCONSISTENT',
      'HOLD',
      `Could not validate registry schema: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function openRegistry(localRoot: string, createIfMissing: boolean): Promise<{ db: Database; existed: boolean } | null> {
  const SQL = await sqlPromise;
  const paths = registryPaths(localRoot);
  const existed = await pathExists(paths.db);
  if (!existed && !createIfMissing) return null;
  try {
    const bytes = existed ? Uint8Array.from(await readFile(paths.db)) : undefined;
    const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    if (existed) assertSchema(db);
    else createSchema(db);
    return { db, existed };
  } catch (cause) {
    if (cause instanceof LocalRegistryError) throw cause;
    registryError(
      'LOCAL_REGISTRY_INCONSISTENT',
      'HOLD',
      `Could not open local registry database: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function persistRegistry(localRoot: string, db: Database, hooks: LocalRegistryTestHooks = {}): Promise<void> {
  const paths = registryPaths(localRoot);
  await mkdir(paths.directory, { recursive: true });
  const temporary = resolve(paths.directory, `.hdh_registry.${randomUUID()}.tmp`);
  try {
    if (hooks.beforePersist) await hooks.beforePersist();
    const bytes = Uint8Array.from(db.export());
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, paths.db);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (cause instanceof LocalRegistryError) throw cause;
    registryError(
      'REGISTRY_TRANSACTION_FAIL',
      'HOLD',
      `Registry persistence failed; accepted DATA_PACKET was not modified: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function value(row: Record<string, SqlJsValue>, key: string): SqlJsValue {
  return row[key] ?? null;
}

function stringOrNull(input: SqlJsValue): string | null {
  return input === null || input === undefined ? null : String(input);
}

function rowFromObject(raw: Record<string, SqlJsValue>): LocalRegistryDatasetRow {
  const promotion = Number(value(raw, 'canonical_promotion_allowed'));
  const tickRaw = value(raw, 'tick_count_total');
  const row: LocalRegistryDatasetRow = {
    dataset_id: String(value(raw, 'dataset_id')),
    local_packet_path: String(value(raw, 'local_packet_path')),
    symbol: String(value(raw, 'symbol')),
    requested_from_utc: String(value(raw, 'requested_from_utc')),
    requested_to_utc: String(value(raw, 'requested_to_utc')),
    tick_count_total: tickRaw === null ? null : Number(tickRaw),
    source_hash_root: String(value(raw, 'source_hash_root')),
    canonical_logical_hash_root: String(value(raw, 'canonical_logical_hash_root')),
    parquet_file_hash_root: stringOrNull(value(raw, 'parquet_file_hash_root')),
    mt5_derivative_hash_root: stringOrNull(value(raw, 'mt5_derivative_hash_root')),
    integrity_status: String(value(raw, 'integrity_status')),
    canonical_promotion_allowed: promotion === 1,
    manifest_sha256: String(value(raw, 'manifest_sha256')),
    sha256sums_sha256: String(value(raw, 'sha256sums_sha256')),
    import_status: String(value(raw, 'import_status')) as 'IMPORTED',
    import_run_id: String(value(raw, 'import_run_id')),
    imported_at_utc: String(value(raw, 'imported_at_utc')),
    source_transport_type: stringOrNull(value(raw, 'source_transport_type')) as 'DIRECTORY' | 'ZIP' | null,
    workflow_run_id: stringOrNull(value(raw, 'workflow_run_id')),
    artifact_id: stringOrNull(value(raw, 'artifact_id')),
    artifact_digest: stringOrNull(value(raw, 'artifact_digest')),
  };
  if (!DATASET_ID_RE.test(row.dataset_id) || !Number.isSafeInteger(row.tick_count_total ?? 0) || row.import_status !== 'IMPORTED') {
    registryError('LOCAL_REGISTRY_INCONSISTENT', 'HOLD', `Registry row contains invalid operational metadata for ${row.dataset_id}`);
  }
  return row;
}

function queryRows(db: Database, sql: string, params: SqlJsValue[] = []): LocalRegistryDatasetRow[] {
  const stmt = db.prepare(sql);
  try {
    if (params.length > 0) stmt.bind(params);
    const rows: LocalRegistryDatasetRow[] = [];
    while (stmt.step()) rows.push(rowFromObject(stmt.getAsObject()));
    return rows;
  } finally {
    stmt.free();
  }
}

function getRow(db: Database, datasetId: string): LocalRegistryDatasetRow | null {
  return queryRows(db, `SELECT ${DATASET_COLUMNS.join(', ')} FROM datasets WHERE dataset_id = ?`, [datasetId])[0] ?? null;
}

function scanMatchesRow(scan: LocalPacketScanResult, row: LocalRegistryDatasetRow, localRoot: string): boolean {
  const expected = expectedPacketPath(localRoot, scan.dataset_id);
  return resolve(row.local_packet_path) === expected
    && resolve(scan.intended_destination_path) === expected
    && row.dataset_id === scan.dataset_id
    && row.symbol === scan.symbol
    && row.requested_from_utc === scan.requested_from_utc
    && row.requested_to_utc === scan.requested_to_utc
    && row.tick_count_total === scan.tick_count_total
    && row.source_hash_root === scan.source_hash_root
    && row.canonical_logical_hash_root === scan.canonical_logical_hash_root
    && row.parquet_file_hash_root === scan.parquet_file_hash_root
    && row.mt5_derivative_hash_root === scan.mt5_derivative_hash_root
    && row.integrity_status === scan.integrity_status
    && row.canonical_promotion_allowed === scan.canonical_promotion_allowed
    && row.manifest_sha256 === scan.manifest_sha256
    && row.sha256sums_sha256 === scan.sha256sums_sha256
    && row.import_status === 'IMPORTED';
}

function scansEquivalent(left: LocalPacketScanResult, right: LocalPacketScanResult): boolean {
  return left.dataset_id === right.dataset_id
    && left.manifest_sha256 === right.manifest_sha256
    && left.sha256sums_sha256 === right.sha256sums_sha256
    && left.packet_file_count === right.packet_file_count
    && left.packet_total_bytes === right.packet_total_bytes;
}

async function scanInstalledPacket(localRoot: string, datasetId: string): Promise<LocalPacketScanResult> {
  const packetPath = expectedPacketPath(localRoot, datasetId);
  let scan: LocalPacketScanResult;
  try {
    scan = await scanLocalDatasetPacket(packetPath, localRoot);
  } catch (cause) {
    if (cause instanceof LocalPacketError) {
      registryError(
        'LOCAL_REGISTRY_INCONSISTENT',
        'HOLD',
        `Registered local DATA_PACKET is missing or invalid: ${cause.code}: ${cause.message}`,
        cause.code,
      );
    }
    if (isEnoent(cause)) {
      registryError('LOCAL_REGISTRY_INCONSISTENT', 'HOLD', `Registered local DATA_PACKET is missing: ${packetPath}`);
    }
    throw cause;
  }
  if (scan.dataset_id !== datasetId || resolve(scan.intended_destination_path) !== packetPath) {
    registryError(
      'LOCAL_REGISTRY_INCONSISTENT',
      'HOLD',
      `Verified manifest dataset_id/destination does not match explicit local registry target: ${datasetId}`,
    );
  }
  return scan;
}

function rowForScan(
  scan: LocalPacketScanResult,
  localRoot: string,
  sourceTransportType: 'DIRECTORY' | 'ZIP' | null,
  importRunId: string,
  importedAtUtc: string,
): LocalRegistryDatasetRow {
  return {
    dataset_id: scan.dataset_id,
    local_packet_path: expectedPacketPath(localRoot, scan.dataset_id),
    symbol: scan.symbol,
    requested_from_utc: scan.requested_from_utc,
    requested_to_utc: scan.requested_to_utc,
    tick_count_total: scan.tick_count_total,
    source_hash_root: scan.source_hash_root,
    canonical_logical_hash_root: scan.canonical_logical_hash_root,
    parquet_file_hash_root: scan.parquet_file_hash_root,
    mt5_derivative_hash_root: scan.mt5_derivative_hash_root,
    integrity_status: scan.integrity_status,
    canonical_promotion_allowed: scan.canonical_promotion_allowed,
    manifest_sha256: scan.manifest_sha256,
    sha256sums_sha256: scan.sha256sums_sha256,
    import_status: 'IMPORTED',
    import_run_id: importRunId,
    imported_at_utc: importedAtUtc,
    source_transport_type: sourceTransportType,
    workflow_run_id: null,
    artifact_id: null,
    artifact_digest: null,
  };
}

function insertRow(db: Database, row: LocalRegistryDatasetRow, hooks: LocalRegistryTestHooks = {}): void {
  try {
    db.run('BEGIN IMMEDIATE');
    db.run(
      `INSERT INTO datasets (${DATASET_COLUMNS.join(', ')}) VALUES (${DATASET_COLUMNS.map(() => '?').join(', ')})`,
      [
        row.dataset_id,
        row.local_packet_path,
        row.symbol,
        row.requested_from_utc,
        row.requested_to_utc,
        row.tick_count_total,
        row.source_hash_root,
        row.canonical_logical_hash_root,
        row.parquet_file_hash_root,
        row.mt5_derivative_hash_root,
        row.integrity_status,
        row.canonical_promotion_allowed ? 1 : 0,
        row.manifest_sha256,
        row.sha256sums_sha256,
        row.import_status,
        row.import_run_id,
        row.imported_at_utc,
        row.source_transport_type,
        row.workflow_run_id,
        row.artifact_id,
        row.artifact_digest,
      ],
    );
    if (hooks.beforeCommit) hooks.beforeCommit();
    db.run('COMMIT');
  } catch (cause) {
    try { db.run('ROLLBACK'); } catch { /* ignore rollback failure */ }
    registryError(
      'REGISTRY_TRANSACTION_FAIL',
      'HOLD',
      `Registry transaction rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function withRegistryWriteLock<T>(localRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireRegistryLock(localRoot);
  try {
    return await operation();
  } finally {
    await lock.close();
  }
}

export async function listRegisteredDatasets(localRoot: string): Promise<LocalRegistryListResult> {
  const opened = await openRegistry(localRoot, false);
  if (!opened) {
    return {
      registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION,
      registry_file_status: 'NOT_PRESENT',
      datasets: [],
    };
  }
  try {
    assertSchema(opened.db);
    return {
      registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION,
      registry_file_status: 'PRESENT',
      datasets: queryRows(
        opened.db,
        `SELECT ${DATASET_COLUMNS.join(', ')} FROM datasets ORDER BY imported_at_utc ASC, dataset_id ASC`,
      ),
    };
  } finally {
    opened.db.close();
  }
}

export async function showRegisteredDataset(localRoot: string, datasetId: string): Promise<LocalRegistryShowResult> {
  assertDatasetId(datasetId);
  const opened = await openRegistry(localRoot, false);
  if (!opened) registryError('DATASET_NOT_REGISTERED', 'FAIL', `Local registry does not exist for dataset: ${datasetId}`);
  try {
    assertSchema(opened.db);
    const row = getRow(opened.db, datasetId);
    if (!row) registryError('DATASET_NOT_REGISTERED', 'FAIL', `Dataset is not registered: ${datasetId}`);
    return { registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION, dataset: row };
  } finally {
    opened.db.close();
  }
}

export async function verifyRegisteredDataset(localRoot: string, datasetId: string): Promise<LocalRegistryVerifyResult> {
  const shown = await showRegisteredDataset(localRoot, datasetId);
  const scan = await scanInstalledPacket(localRoot, datasetId);
  if (!scanMatchesRow(scan, shown.dataset, localRoot)) {
    registryError('LOCAL_REGISTRY_INCONSISTENT', 'HOLD', `Registry row does not match verified local DATA_PACKET: ${datasetId}`);
  }
  return {
    ...shown,
    registry_verify_status: 'PASS',
    packet_revalidation_status: 'PASS',
  };
}

export async function adoptInstalledDataset(
  localRoot: string,
  datasetId: string,
  hooks: LocalRegistryTestHooks = {},
): Promise<LocalRegistryMutationResult> {
  assertDatasetId(datasetId);
  return withRegistryWriteLock(localRoot, async () => {
    const scan = await scanInstalledPacket(localRoot, datasetId);
    const opened = await openRegistry(localRoot, true);
    if (!opened) throw new Error('Registry creation unexpectedly returned null');
    try {
      assertSchema(opened.db);
      const existing = getRow(opened.db, datasetId);
      if (existing) {
        if (!scanMatchesRow(scan, existing, localRoot)) {
          registryError('LOCAL_REGISTRY_INCONSISTENT', 'HOLD', `Existing registry row conflicts with verified local DATA_PACKET: ${datasetId}`);
        }
        return {
          local_import_status: 'ALREADY_REGISTERED',
          operation: 'ADOPT_REGISTER',
          dataset_id: datasetId,
          final_packet_path: scan.intended_destination_path,
          filesystem_mutation_performed: false,
          registry_mutation_performed: false,
          import_run_id: null,
          registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION,
        };
      }

      const runId = randomUUID();
      const row = rowForScan(scan, localRoot, null, runId, new Date().toISOString());
      insertRow(opened.db, row, hooks);
      await persistRegistry(localRoot, opened.db, hooks);
      return {
        local_import_status: 'IMPORTED',
        operation: 'ADOPT_REGISTER',
        dataset_id: datasetId,
        final_packet_path: row.local_packet_path,
        filesystem_mutation_performed: false,
        registry_mutation_performed: true,
        import_run_id: runId,
        registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION,
      };
    } finally {
      opened.db.close();
    }
  });
}

export async function importAndRegisterLocalDatasetPacket(
  inputPath: string,
  localRoot: string,
  hooks: LocalRegistryTestHooks = {},
): Promise<LocalRegistryMutationResult> {
  const candidate = await scanLocalDatasetPacket(inputPath, localRoot);
  return withRegistryWriteLock(localRoot, async () => {
    const opened = await openRegistry(localRoot, true);
    if (!opened) throw new Error('Registry creation unexpectedly returned null');
    try {
      assertSchema(opened.db);
      const existing = getRow(opened.db, candidate.dataset_id);
      if (existing) {
        const installed = await scanInstalledPacket(localRoot, candidate.dataset_id);
        if (!scanMatchesRow(installed, existing, localRoot) || !scansEquivalent(candidate, installed)) {
          registryError(
            'LOCAL_REGISTRY_INCONSISTENT',
            'HOLD',
            `Existing registry/local DATA_PACKET conflicts with import candidate: ${candidate.dataset_id}`,
          );
        }
        return {
          local_import_status: 'ALREADY_REGISTERED',
          operation: 'IMPORT_REGISTER',
          dataset_id: candidate.dataset_id,
          final_packet_path: installed.intended_destination_path,
          filesystem_mutation_performed: false,
          registry_mutation_performed: false,
          import_run_id: null,
          registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION,
        };
      }

      if (await pathExists(candidate.intended_destination_path) || await pathExists(dirname(candidate.intended_destination_path))) {
        registryError(
          'LOCAL_REGISTRY_INCONSISTENT',
          'HOLD',
          `Valid/unregistered or partial local dataset destination requires explicit adopt/reconciliation: ${candidate.dataset_id}`,
        );
      }

      let installed: LocalInstallResult;
      installed = await installLocalDatasetPacketWithRegistryCoordination(inputPath, localRoot);
      if (installed.local_import_status !== 'IMPORTED') {
        registryError(
          'LOCAL_REGISTRY_INCONSISTENT',
          'HOLD',
          `Dataset appeared during coordinated import without a registry row; explicit adopt is required: ${candidate.dataset_id}`,
        );
      }

      const verified = await scanInstalledPacket(localRoot, candidate.dataset_id);
      if (!scansEquivalent(candidate, verified)) {
        registryError(
          'LOCAL_REGISTRY_INCONSISTENT',
          'HOLD',
          `Published DATA_PACKET does not match validated import candidate: ${candidate.dataset_id}`,
        );
      }

      const runId = installed.import_run_id ?? randomUUID();
      const row = rowForScan(verified, localRoot, candidate.input_type, runId, new Date().toISOString());
      insertRow(opened.db, row, hooks);
      await persistRegistry(localRoot, opened.db, hooks);

      return {
        local_import_status: 'IMPORTED',
        operation: 'IMPORT_REGISTER',
        dataset_id: candidate.dataset_id,
        final_packet_path: verified.intended_destination_path,
        filesystem_mutation_performed: true,
        registry_mutation_performed: true,
        import_run_id: runId,
        registry_schema_version: LOCAL_REGISTRY_SCHEMA_VERSION,
      };
    } finally {
      opened.db.close();
    }
  });
}

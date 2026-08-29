import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { convertSourceSnapshotToCanonicalDay } from '../canonical/convert.js';
import { snapshotPathForDay } from '../core/acquire-day.js';
import { atomicWriteFile } from '../core/atomic-write.js';
import { sha256File, sha256Text } from '../core/hash.js';
import { planUtcDays } from '../core/job-planner.js';
import { loadLatestAudits } from '../core/resume.js';
import { buildSha256Sums, verifySha256Sums } from '../core/run-evidence.js';
import type { SymbolRegistryEntry } from '../types/contracts.js';
import { deriveMt5TickDerivativeDay } from '../mt5/derive.js';
import {
  mt5DerivativeContractPathForDay,
  mt5DerivativeCsvPathForDay,
  serializeMt5DerivativeContract,
  serializeMt5DerivativeCsv,
} from '../mt5/write.js';
import { MT5_DERIVATIVE_PROFILE_ID } from '../mt5/types.js';
import { canonicalParquetPathForDay } from '../parquet/write.js';
import { verifyCanonicalParquetFile } from '../parquet/verify.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DATASET_PACKET_MANIFEST_SCHEMA_VERSION,
  assertGitCommit,
  datasetIdFor,
  hashEntriesRoot,
  sameTimestampGroupCount,
} from './contract.js';
import type {
  CanonicalDailyPacketAudit,
  DatasetPacketBuildResult,
  DatasetPacketManifest,
  PacketFileBinding,
} from './types.js';

interface Phase1Manifest {
  schema_version: string;
  run_id: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  daily_source_hashes: { date_utc: string; sha256: string }[];
  source_hash_root: string;
  integrity_status: string;
  phase_1_source_snapshot_only: boolean;
}

interface PrecisionEvidenceBinding {
  symbol: string;
  candidate_price_digits: number;
  candidate_price_scale: number;
  bid_scaled_conversion_fail_count: number;
  ask_scaled_conversion_fail_count: number;
  exact_lattice_pass: boolean;
  precision_status: string;
}

export interface BuildDatasetPacketInput {
  symbol: SymbolRegistryEntry;
  sourceRunRoot: string;
  precisionEvidencePath: string;
  canonicalRoot: string;
  mt5Root: string;
  outRoot: string;
  generatorGitCommit: string;
  generatedAtUtc?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function midnightDatePart(value: string, label: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T00:00:00\.000Z$/.exec(value);
  if (!match) throw new Error(`${label} must be an exact UTC midnight ISO string: ${value}`);
  return match[1]!;
}

function relativePosix(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path)).replaceAll('\\', '/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) {
    throw new Error(`Path is not a file beneath root: root=${root} path=${path}`);
  }
  return rel;
}

async function copyWithShaVerification(source: string, destination: string, expectedSha256: string): Promise<number> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const actual = await sha256File(destination);
  if (actual !== expectedSha256) {
    throw new Error(`SHA changed while copying packet file: expected=${expectedSha256} actual=${actual} source=${source}`);
  }
  return (await stat(destination)).size;
}

function validatePhase1Manifest(manifest: Phase1Manifest, symbol: string): void {
  if (manifest.symbol !== symbol) throw new Error(`Source manifest symbol mismatch: expected=${symbol} actual=${manifest.symbol}`);
  if (manifest.integrity_status !== 'PASS') throw new Error(`Dataset Packet requires PASS source-run integrity: ${manifest.integrity_status}`);
  if (manifest.phase_1_source_snapshot_only !== true) throw new Error('Source manifest is not a Phase 1 Source Snapshot manifest');
  if (!Array.isArray(manifest.daily_source_hashes) || manifest.daily_source_hashes.length === 0) {
    throw new Error('Source manifest has no daily_source_hashes');
  }
  const recomputed = hashEntriesRoot(manifest.daily_source_hashes.map(item => ({ key: item.date_utc, sha256: item.sha256 })));
  if (recomputed !== manifest.source_hash_root) {
    throw new Error(`Source manifest source_hash_root mismatch: expected=${manifest.source_hash_root} recomputed=${recomputed}`);
  }
}

function validatePrecisionEvidence(
  evidence: PrecisionEvidenceBinding,
  symbol: SymbolRegistryEntry,
): void {
  if (evidence.symbol !== symbol.canonical_symbol) {
    throw new Error(`Precision evidence symbol mismatch: expected=${symbol.canonical_symbol} actual=${evidence.symbol}`);
  }
  if (evidence.precision_status !== 'VERIFIED' || evidence.exact_lattice_pass !== true) {
    throw new Error(`Precision evidence is not VERIFIED exact-lattice PASS for ${symbol.canonical_symbol}`);
  }
  if (evidence.bid_scaled_conversion_fail_count !== 0 || evidence.ask_scaled_conversion_fail_count !== 0) {
    throw new Error(`Precision evidence contains scaled conversion failures for ${symbol.canonical_symbol}`);
  }
  if (symbol.precision_status !== 'VERIFIED' || symbol.price_digits === null || symbol.price_scale === null) {
    throw new Error(`Symbol registry precision is not VERIFIED for ${symbol.canonical_symbol}`);
  }
  if (evidence.candidate_price_digits !== symbol.price_digits || evidence.candidate_price_scale !== symbol.price_scale) {
    throw new Error(`Precision evidence does not match symbol registry for ${symbol.canonical_symbol}`);
  }
}

function packetReadme(manifest: DatasetPacketManifest): string {
  return `# CHAPPY Historical Data Hub Dataset Packet\n\n`+
    `Dataset ID: \`${manifest.dataset_id}\`\n\n`+
    `Symbol: \`${manifest.symbol}\`  \n`+
    `Range: \`${manifest.requested_from_utc}\` → \`${manifest.requested_to_utc}\`  \n`+
    `Source run: \`${manifest.source_run_id}\`  \n`+
    `Source hash root: \`${manifest.source_hash_root}\`  \n`+
    `Canonical logical hash root: \`${manifest.canonical_logical_hash_root}\`  \n`+
    `Parquet physical hash root: \`${manifest.parquet_file_hash_root}\`  \n`+
    `MT5 derivative physical hash root: \`${manifest.mt5_derivative_hash_root}\`\n\n`+
    `## Authority\n\n`+
    `This packet is built only from the frozen Source Tick Snapshot bytes referenced by the Phase 1 PASS provenance and exact SHA chain. The packet builder performs no live market-data reacquisition. Live reacquisition is a separate Source Drift Audit and cannot silently replace this packet baseline.\n\n`+
    `## Bindings\n\n`+
    `- \`numba/dataset.json\` binds Numba to the packet Canonical Parquet files and their Canonical logical row hashes.\n`+
    `- \`mt5/symbol_contract.json\` binds MT5 derivative tick CSV files to the same Canonical logical rows.\n`+
    `- Bid/Ask remain separate. Bid/Ask-side Source volume remains Canonical-only and is not lossily merged into MqlTick volume.\n`+
    `- No sorting repair, dedupe, same-timestamp merge, gap fill, or silent price rounding is performed.\n\n`+
    `Verify all packet file bytes with \`SHA256SUMS.txt\` before downstream use.\n`;
}

export async function buildDatasetPacket(input: BuildDatasetPacketInput): Promise<DatasetPacketBuildResult> {
  assertGitCommit(input.generatorGitCommit);
  const outRoot = resolve(input.outRoot);
  const sourceRunRoot = resolve(input.sourceRunRoot);
  const canonicalRoot = resolve(input.canonicalRoot);
  const mt5Root = resolve(input.mt5Root);
  const precisionEvidencePath = resolve(input.precisionEvidencePath);
  if (await exists(outRoot)) throw new Error(`Dataset Packet destination already exists: ${outRoot}`);
  if ([sourceRunRoot, canonicalRoot, mt5Root].includes(outRoot)) throw new Error('Dataset Packet output must be separate from source/canonical/MT5 inputs');

  const sourceManifest = await readJson<Phase1Manifest>(resolve(sourceRunRoot, 'manifest.json'));
  validatePhase1Manifest(sourceManifest, input.symbol.canonical_symbol);
  const fromDate = midnightDatePart(sourceManifest.requested_from_utc, 'requested_from_utc');
  const toDate = midnightDatePart(sourceManifest.requested_to_utc, 'requested_to_utc');
  const days = planUtcDays(fromDate, toDate);
  if (days.length === 0) throw new Error('Dataset Packet range contains no UTC days');

  const precisionEvidenceBytes = await readFile(precisionEvidencePath);
  const precisionEvidenceSha256 = await sha256File(precisionEvidencePath);
  const precisionEvidence = JSON.parse(precisionEvidenceBytes.toString('utf8')) as PrecisionEvidenceBinding;
  validatePrecisionEvidence(precisionEvidence, input.symbol);

  const datasetId = datasetIdFor({
    canonical_schema_version: CANONICAL_SCHEMA_VERSION,
    symbol: input.symbol.canonical_symbol,
    requested_from_utc: sourceManifest.requested_from_utc,
    requested_to_utc: sourceManifest.requested_to_utc,
    source_hash_root: sourceManifest.source_hash_root,
    precision_evidence_sha256: precisionEvidenceSha256,
    generator_git_commit: input.generatorGitCommit,
  });

  const sourceAudits = await loadLatestAudits(resolve(sourceRunRoot, 'integrity', 'daily_audit.jsonl'));
  const manifestSourceHashes = new Map(sourceManifest.daily_source_hashes.map(item => [item.date_utc, item.sha256]));
  const sourceHashEntries: { key: string; sha256: string }[] = [];
  for (const day of days) {
    const audit = sourceAudits.get(day.dateUtc);
    if (!audit || audit.status !== 'PASS' || !audit.snapshot_sha256 || !audit.snapshot_path) {
      throw new Error(`Dataset Packet promotion requires PASS Source day: ${day.dateUtc}`);
    }
    if (manifestSourceHashes.get(day.dateUtc) !== audit.snapshot_sha256) {
      throw new Error(`Source daily hash provenance mismatch for ${day.dateUtc}`);
    }
    sourceHashEntries.push({ key: day.dateUtc, sha256: audit.snapshot_sha256 });
  }
  const actualSourceHashRoot = hashEntriesRoot(sourceHashEntries);
  if (actualSourceHashRoot !== sourceManifest.source_hash_root) {
    throw new Error(`Source audit hash root mismatch: manifest=${sourceManifest.source_hash_root} audit=${actualSourceHashRoot}`);
  }

  const parent = dirname(outRoot);
  await mkdir(parent, { recursive: true });
  const tempRoot = `${outRoot}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(tempRoot, { recursive: false });

  try {
    const canonicalAudits: CanonicalDailyPacketAudit[] = [];
    const parquetBindings: PacketFileBinding[] = [];
    const mt5Bindings: PacketFileBinding[] = [];

    for (const day of days) {
      const sourceAudit = sourceAudits.get(day.dateUtc)!;
      const canonical = await convertSourceSnapshotToCanonicalDay({
        symbol: input.symbol,
        dateUtc: day.dateUtc,
        sourceSnapshotPath: snapshotPathForDay(sourceRunRoot, input.symbol, day.dateUtc),
        expectedSourceSnapshotSha256: sourceAudit.snapshot_sha256!,
        expectedSourceRowCount: sourceAudit.tick_count,
      });
      if (canonical.source_row_count !== canonical.canonical_row_count) {
        throw new Error(`Canonical row count mismatch for ${day.dateUtc}`);
      }

      const sourceParquetPath = canonicalParquetPathForDay(canonicalRoot, canonical.symbol, canonical.date_utc);
      const parquetVerification = await verifyCanonicalParquetFile(
        sourceParquetPath,
        canonical.rows,
        canonical.logical_row_sha256,
      );
      if (!parquetVerification.schema_match || !parquetVerification.semantic_rows_match || !parquetVerification.logical_hash_match) {
        throw new Error(`Canonical Parquet verification failed for ${day.dateUtc}`);
      }
      const parquetSha256 = await sha256File(sourceParquetPath);
      const parquetRel = relativePosix(canonicalRoot, sourceParquetPath);
      if (!parquetRel.startsWith(`canonical/${canonical.symbol}/`)) {
        throw new Error(`Unexpected Canonical Parquet partition path: ${parquetRel}`);
      }
      const parquetSize = await copyWithShaVerification(
        sourceParquetPath,
        resolve(tempRoot, parquetRel),
        parquetSha256,
      );

      const derivative = deriveMt5TickDerivativeDay(canonical);
      const sourceMt5CsvPath = mt5DerivativeCsvPathForDay(mt5Root, canonical.symbol, canonical.date_utc);
      const sourceMt5ContractPath = mt5DerivativeContractPathForDay(mt5Root, canonical.symbol, canonical.date_utc);
      const expectedCsvSha256 = sha256Text(serializeMt5DerivativeCsv(derivative));
      const actualCsvSha256 = await sha256File(sourceMt5CsvPath);
      if (actualCsvSha256 !== expectedCsvSha256) {
        throw new Error(`MT5 derivative CSV is not the deterministic derivative of Canonical rows for ${day.dateUtc}`);
      }
      const expectedDayContractSha256 = sha256Text(serializeMt5DerivativeContract(derivative));
      const actualDayContractSha256 = await sha256File(sourceMt5ContractPath);
      if (actualDayContractSha256 !== expectedDayContractSha256) {
        throw new Error(`MT5 derivative day contract mismatch for ${day.dateUtc}`);
      }
      const mt5Rel = relativePosix(mt5Root, sourceMt5CsvPath);
      if (!mt5Rel.startsWith(`mt5/ticks/${canonical.symbol}/`)) {
        throw new Error(`Unexpected MT5 derivative partition path: ${mt5Rel}`);
      }
      const mt5Size = await copyWithShaVerification(
        sourceMt5CsvPath,
        resolve(tempRoot, mt5Rel),
        actualCsvSha256,
      );

      parquetBindings.push({
        date_utc: canonical.date_utc,
        path: parquetRel,
        physical_sha256: parquetSha256,
        file_size_bytes: parquetSize,
        canonical_logical_row_hash: canonical.logical_row_sha256,
        row_count: canonical.canonical_row_count,
        source_snapshot_sha256: canonical.source_snapshot_sha256,
      });
      mt5Bindings.push({
        date_utc: canonical.date_utc,
        path: mt5Rel,
        physical_sha256: actualCsvSha256,
        file_size_bytes: mt5Size,
        canonical_logical_row_hash: canonical.logical_row_sha256,
        row_count: canonical.canonical_row_count,
        source_snapshot_sha256: canonical.source_snapshot_sha256,
      });
      canonicalAudits.push({
        symbol: canonical.symbol,
        date_utc: canonical.date_utc,
        source_snapshot_sha256: canonical.source_snapshot_sha256,
        source_tick_count: canonical.source_row_count,
        canonical_tick_count: canonical.canonical_row_count,
        first_timestamp_msc: canonical.first_timestamp_msc,
        last_timestamp_msc: canonical.last_timestamp_msc,
        exact_duplicate_count: sourceAudit.exact_duplicate_count,
        same_timestamp_group_count: sameTimestampGroupCount(canonical.rows),
        out_of_order_count: sourceAudit.out_of_order_count,
        invalid_bid_count: sourceAudit.invalid_bid_count,
        invalid_ask_count: sourceAudit.invalid_ask_count,
        negative_spread_count: sourceAudit.negative_spread_count,
        bid_scaled_conversion_fail_count: 0,
        ask_scaled_conversion_fail_count: 0,
        parquet_sha256: parquetSha256,
        canonical_logical_row_hash: canonical.logical_row_sha256,
        source_order_preservation: 'PASS',
        hash_chain_status: 'PASS',
        status: 'PASS',
      });
    }

    const canonicalLogicalHashRoot = hashEntriesRoot(
      parquetBindings.map(item => ({ key: item.date_utc, sha256: item.canonical_logical_row_hash })),
    );
    const parquetFileHashRoot = hashEntriesRoot(
      parquetBindings.map(item => ({ key: item.path, sha256: item.physical_sha256 })),
    );
    const mt5DerivativeHashRoot = hashEntriesRoot(
      mt5Bindings.map(item => ({ key: item.path, sha256: item.physical_sha256 })),
    );
    const tickCountTotal = canonicalAudits.reduce((total, audit) => total + audit.canonical_tick_count, 0);
    const generatedAtUtc = input.generatedAtUtc ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(generatedAtUtc)) || !generatedAtUtc.endsWith('Z')) {
      throw new Error(`generated_at_utc must be an ISO UTC timestamp: ${generatedAtUtc}`);
    }

    const manifest: DatasetPacketManifest = {
      manifest_schema_version: DATASET_PACKET_MANIFEST_SCHEMA_VERSION,
      dataset_id: datasetId,
      canonical_schema_version: CANONICAL_SCHEMA_VERSION,
      generator_git_commit: input.generatorGitCommit,
      source_run_id: sourceManifest.run_id,
      source_hash_root: sourceManifest.source_hash_root,
      symbol: input.symbol.canonical_symbol,
      requested_from_utc: sourceManifest.requested_from_utc,
      requested_to_utc: sourceManifest.requested_to_utc,
      tick_count_total: tickCountTotal,
      canonical_file_count: parquetBindings.length,
      price_digits: input.symbol.price_digits!,
      price_scale: input.symbol.price_scale!,
      precision_status: 'VERIFIED',
      precision_evidence_sha256: precisionEvidenceSha256,
      canonical_logical_hash_root: canonicalLogicalHashRoot,
      parquet_file_hash_root: parquetFileHashRoot,
      mt5_derivative_hash_root: mt5DerivativeHashRoot,
      integrity_status: 'PASS',
      canonical_promotion_allowed: true,
      generated_at_utc: generatedAtUtc,
    };

    const numbaBinding = {
      schema_version: '0.1.0',
      dataset_id: datasetId,
      dataset_binding_status: 'BOUND_P2_5_PACKET',
      canonical_schema_version: CANONICAL_SCHEMA_VERSION,
      symbol: manifest.symbol,
      requested_from_utc: manifest.requested_from_utc,
      requested_to_utc: manifest.requested_to_utc,
      source_hash_root: manifest.source_hash_root,
      canonical_logical_hash_root: canonicalLogicalHashRoot,
      price_digits: manifest.price_digits,
      price_scale: manifest.price_scale,
      parquet_files: parquetBindings,
    } as const;

    const mt5SymbolContract = {
      schema_version: '0.1.0',
      dataset_id: datasetId,
      dataset_binding_status: 'BOUND_P2_5_PACKET',
      canonical_schema_version: CANONICAL_SCHEMA_VERSION,
      profile_id: MT5_DERIVATIVE_PROFILE_ID,
      symbol: manifest.symbol,
      requested_from_utc: manifest.requested_from_utc,
      requested_to_utc: manifest.requested_to_utc,
      source_hash_root: manifest.source_hash_root,
      canonical_logical_hash_root: canonicalLogicalHashRoot,
      price_digits: manifest.price_digits,
      price_scale: manifest.price_scale,
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
      tick_files: mt5Bindings,
    } as const;

    const integrityReport = {
      schema_version: '0.1.0',
      dataset_id: datasetId,
      source_authority: 'FROZEN_ACCEPTED_SOURCE_SNAPSHOT_BYTES_PLUS_SHA_PASS_PROVENANCE',
      live_reacquisition_policy: 'SOURCE_DRIFT_AUDIT_ONLY_NO_SILENT_REBASELINE',
      source_run_id: sourceManifest.run_id,
      source_hash_root: sourceManifest.source_hash_root,
      source_hash_root_verified: true,
      precision_evidence_sha256: precisionEvidenceSha256,
      precision_status: 'VERIFIED',
      precision_binding_verified: true,
      canonical_daily_audit_count: canonicalAudits.length,
      canonical_daily_pass_count: canonicalAudits.length,
      source_order_preservation: 'PASS',
      scaled_conversion_fail_count_total: 0,
      canonical_logical_hash_root: canonicalLogicalHashRoot,
      parquet_file_hash_root: parquetFileHashRoot,
      mt5_derivative_hash_root: mt5DerivativeHashRoot,
      numba_binding_status: 'BOUND_P2_5_PACKET',
      mt5_binding_status: 'BOUND_P2_5_PACKET',
      hash_chain_status: 'PASS',
      integrity_status: 'PASS',
      canonical_promotion_allowed: true,
    } as const;

    await mkdir(resolve(tempRoot, 'audit'), { recursive: true });
    await mkdir(resolve(tempRoot, 'numba'), { recursive: true });
    await mkdir(resolve(tempRoot, 'mt5'), { recursive: true });
    await copyWithShaVerification(
      precisionEvidencePath,
      resolve(tempRoot, 'audit', 'precision_evidence.json'),
      precisionEvidenceSha256,
    );
    await atomicWriteFile(
      resolve(tempRoot, 'audit', 'canonical_daily_audit.jsonl'),
      `${canonicalAudits.map(audit => JSON.stringify(audit)).join('\n')}\n`,
    );
    await atomicWriteFile(
      resolve(tempRoot, 'audit', 'integrity_report.json'),
      `${JSON.stringify(integrityReport, null, 2)}\n`,
    );
    await atomicWriteFile(resolve(tempRoot, 'numba', 'dataset.json'), `${JSON.stringify(numbaBinding, null, 2)}\n`);
    await atomicWriteFile(resolve(tempRoot, 'mt5', 'symbol_contract.json'), `${JSON.stringify(mt5SymbolContract, null, 2)}\n`);
    await atomicWriteFile(resolve(tempRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await atomicWriteFile(resolve(tempRoot, 'README.md'), packetReadme(manifest));

    await buildSha256Sums(tempRoot);
    const sumsVerification = await verifySha256Sums(tempRoot);
    if (sumsVerification.mismatches.length > 0) {
      throw new Error(`Dataset Packet SHA256SUMS verification failed: ${sumsVerification.mismatches.join(', ')}`);
    }
    if (await exists(outRoot)) throw new Error(`Dataset Packet destination appeared during build: ${outRoot}`);
    await rename(tempRoot, outRoot);
    return { manifest, sha256sums_checked_files: sumsVerification.checked };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { convertSourceSnapshotToCanonicalDay } from './canonical/convert.js';
import { snapshotPathForDay } from './core/acquire-day.js';
import { atomicWriteFile } from './core/atomic-write.js';
import { loadLatestAudits } from './core/resume.js';
import { loadSymbolRegistry, resolveSymbol } from './core/symbol-registry.js';
import { canonicalParquetPathForDay, writeCanonicalParquetDay } from './parquet/write.js';

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options.set(key, value);
  }
  return options;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function resolveSafeRelativePath(pathArg: string, optionName: string): string {
  if (isAbsolute(pathArg)) throw new Error(`--${optionName} must be a relative path`);
  const cwd = resolve(process.cwd());
  const resolved = resolve(cwd, pathArg);
  const rel = relative(cwd, resolved);
  if (!rel || rel === '.' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`--${optionName} must resolve inside the current working directory`);
  }
  return resolved;
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const symbolArg = required(options, 'symbol').toUpperCase();
  const dateUtc = required(options, 'date');
  const sourceRunArg = required(options, 'source-run');
  const outArg = required(options, 'out');
  const sourceRunRoot = resolveSafeRelativePath(sourceRunArg, 'source-run');
  const outRoot = resolveSafeRelativePath(outArg, 'out');
  if (sourceRunRoot === outRoot) throw new Error('--source-run and --out must be different directories');

  const registry = await loadSymbolRegistry(resolve(process.cwd(), 'config', 'symbol_registry.json'));
  const symbol = resolveSymbol(registry, symbolArg);
  const audits = await loadLatestAudits(resolve(sourceRunRoot, 'integrity', 'daily_audit.jsonl'));
  const audit = audits.get(dateUtc);
  if (!audit || audit.status !== 'PASS' || !audit.snapshot_sha256 || !audit.snapshot_path) {
    throw new Error(`Parquet generation requires PASS daily audit with snapshot evidence for ${dateUtc}`);
  }

  const snapshotPath = snapshotPathForDay(sourceRunRoot, symbol, dateUtc);
  const canonical = await convertSourceSnapshotToCanonicalDay({
    symbol,
    dateUtc,
    sourceSnapshotPath: snapshotPath,
    expectedSourceSnapshotSha256: audit.snapshot_sha256,
    expectedSourceRowCount: audit.tick_count,
  });

  const parquetPath = canonicalParquetPathForDay(outRoot, canonical.symbol, canonical.date_utc);
  const parquet = await writeCanonicalParquetDay(canonical, parquetPath);
  const gitCommitSha = gitCommit();
  const relativeParquetPath = relative(outRoot, parquet.path).split('\\').join('/');

  const evidence = {
    schema_version: '0.1.0',
    symbol: canonical.symbol,
    date_utc: canonical.date_utc,
    git_commit: gitCommitSha,
    precision_status: symbol.precision_status,
    price_digits: canonical.price_digits,
    price_scale: canonical.price_scale,
    source_snapshot_sha256: canonical.source_snapshot_sha256,
    source_row_count: canonical.source_row_count,
    canonical_row_count: canonical.canonical_row_count,
    first_timestamp_msc: canonical.first_timestamp_msc,
    last_timestamp_msc: canonical.last_timestamp_msc,
    canonical_logical_row_sha256: canonical.logical_row_sha256,
    parquet_generated: true,
    parquet_path: relativeParquetPath,
    parquet_physical_sha256: parquet.physical_sha256,
    parquet_file_size_bytes: parquet.file_size_bytes,
    parquet_resumed_existing: parquet.resumed_existing,
    writer_package: parquet.writer_package,
    writer_version: parquet.writer_version,
    reader_package: parquet.reader_package,
    reader_version: parquet.reader_version,
    profile: parquet.profile,
    readback_row_count: parquet.verification.row_count,
    readback_schema_match: parquet.verification.schema_match,
    readback_semantic_rows_match: parquet.verification.semantic_rows_match,
    readback_logical_row_sha256: parquet.verification.logical_row_sha256,
    readback_logical_hash_match: parquet.verification.logical_hash_match,
    order_policy: 'SOURCE_SEQ_PRESERVED',
    dedupe_applied: false,
    gap_fill_applied: false,
  } as const;

  await mkdir(outRoot, { recursive: true });
  await atomicWriteFile(resolve(outRoot, 'parquet_evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  await atomicWriteFile(
    resolve(outRoot, 'repro_command.txt'),
    `npm run parquet -- --symbol ${symbolArg} --date ${dateUtc} --source-run ${sourceRunArg} --out ${outArg}\n`,
  );
  await atomicWriteFile(
    resolve(outRoot, 'parquet.log'),
    `symbol=${canonical.symbol} date=${canonical.date_utc} git_commit=${gitCommitSha} rows=${canonical.canonical_row_count} logical_row_sha256=${canonical.logical_row_sha256} parquet_sha256=${parquet.physical_sha256} parquet_bytes=${parquet.file_size_bytes} profile=${parquet.profile.profile_id} readback_hash_match=${parquet.verification.logical_hash_match} resumed=${parquet.resumed_existing}\n`,
  );

  JSON.parse(await readFile(resolve(outRoot, 'parquet_evidence.json'), 'utf8'));
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

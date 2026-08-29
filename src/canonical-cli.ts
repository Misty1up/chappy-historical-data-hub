#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { snapshotPathForDay } from './core/acquire-day.js';
import { atomicWriteFile } from './core/atomic-write.js';
import { loadLatestAudits } from './core/resume.js';
import { loadSymbolRegistry, resolveSymbol } from './core/symbol-registry.js';
import { convertSourceSnapshotToCanonicalDay } from './canonical/convert.js';

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
    throw new Error(`Canonical conversion requires PASS daily audit with snapshot evidence for ${dateUtc}`);
  }

  const snapshotPath = snapshotPathForDay(sourceRunRoot, symbol, dateUtc);
  const result = await convertSourceSnapshotToCanonicalDay({
    symbol,
    dateUtc,
    sourceSnapshotPath: snapshotPath,
    expectedSourceSnapshotSha256: audit.snapshot_sha256,
    expectedSourceRowCount: audit.tick_count,
  });

  const gitCommitSha = gitCommit();
  const evidence = {
    schema_version: '0.1.0',
    symbol: result.symbol,
    date_utc: result.date_utc,
    git_commit: gitCommitSha,
    precision_status: symbol.precision_status,
    price_digits: result.price_digits,
    price_scale: result.price_scale,
    source_snapshot_sha256: result.source_snapshot_sha256,
    source_row_count: result.source_row_count,
    canonical_row_count: result.canonical_row_count,
    row_count_match: result.source_row_count === result.canonical_row_count,
    first_timestamp_msc: result.first_timestamp_msc,
    last_timestamp_msc: result.last_timestamp_msc,
    logical_row_sha256: result.logical_row_sha256,
    order_policy: 'SOURCE_SEQ_PRESERVED',
    dedupe_applied: false,
    gap_fill_applied: false,
    parquet_generated: false,
  } as const;

  await mkdir(outRoot, { recursive: true });
  await atomicWriteFile(resolve(outRoot, 'canonical_evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  await atomicWriteFile(
    resolve(outRoot, 'repro_command.txt'),
    `npm run canonical -- --symbol ${symbolArg} --date ${dateUtc} --source-run ${sourceRunArg} --out ${outArg}\n`,
  );
  await atomicWriteFile(
    resolve(outRoot, 'canonical.log'),
    `symbol=${result.symbol} date=${result.date_utc} git_commit=${gitCommitSha} source_rows=${result.source_row_count} canonical_rows=${result.canonical_row_count} logical_row_sha256=${result.logical_row_sha256} price_digits=${result.price_digits} price_scale=${result.price_scale} parquet_generated=false\n`,
  );

  // Re-read the evidence file to ensure the write completed before returning success.
  JSON.parse(await readFile(resolve(outRoot, 'canonical_evidence.json'), 'utf8'));
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

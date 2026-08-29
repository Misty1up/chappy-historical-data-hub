#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { convertSourceSnapshotToCanonicalDay } from './canonical/convert.js';
import { snapshotPathForDay } from './core/acquire-day.js';
import { atomicWriteFile } from './core/atomic-write.js';
import { loadLatestAudits } from './core/resume.js';
import { loadSymbolRegistry, resolveSymbol } from './core/symbol-registry.js';
import { deriveMt5TickDerivativeDay } from './mt5/derive.js';
import { writeMt5DerivativeDay } from './mt5/write.js';

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
  if (symbol.precision_status !== 'VERIFIED') throw new Error(`MT5 derivative requires VERIFIED precision: ${symbolArg}`);

  const audits = await loadLatestAudits(resolve(sourceRunRoot, 'integrity', 'daily_audit.jsonl'));
  const audit = audits.get(dateUtc);
  if (!audit || audit.status !== 'PASS' || !audit.snapshot_sha256 || !audit.snapshot_path) {
    throw new Error(`MT5 derivative requires PASS daily audit with snapshot evidence for ${dateUtc}`);
  }

  const canonical = await convertSourceSnapshotToCanonicalDay({
    symbol,
    dateUtc,
    sourceSnapshotPath: snapshotPathForDay(sourceRunRoot, symbol, dateUtc),
    expectedSourceSnapshotSha256: audit.snapshot_sha256,
    expectedSourceRowCount: audit.tick_count,
  });
  const derivative = deriveMt5TickDerivativeDay(canonical);
  const written = await writeMt5DerivativeDay(derivative, outRoot);
  const gitCommitSha = gitCommit();

  const evidence = {
    schema_version: '0.1.0',
    profile_id: derivative.profile_id,
    symbol: derivative.symbol,
    date_utc: derivative.date_utc,
    git_commit: gitCommitSha,
    precision_status: symbol.precision_status,
    price_digits: derivative.price_digits,
    price_scale: derivative.price_scale,
    source_snapshot_sha256: derivative.source_snapshot_sha256,
    source_row_count: canonical.source_row_count,
    canonical_row_count: derivative.canonical_row_count,
    canonical_logical_row_sha256: derivative.canonical_logical_row_sha256,
    from_msc: derivative.from_msc.toString(),
    to_msc: derivative.to_msc.toString(),
    mt5_csv_path: relative(outRoot, written.csv_path).split('\\').join('/'),
    mt5_csv_physical_sha256: written.csv_physical_sha256,
    mt5_csv_file_size_bytes: written.csv_file_size_bytes,
    mt5_contract_path: relative(outRoot, written.contract_path).split('\\').join('/'),
    mt5_contract_physical_sha256: written.contract_physical_sha256,
    mt5_contract_file_size_bytes: written.contract_file_size_bytes,
    resumed_existing: written.resumed_existing,
    order_policy: derivative.order_policy,
    same_timestamp_policy: derivative.same_timestamp_policy,
    dedupe_applied: derivative.dedupe_applied,
    gap_fill_applied: derivative.gap_fill_applied,
    bid_ask_mapping: derivative.bid_ask_mapping,
    volume_mapping_policy: derivative.volume_mapping_policy,
    dataset_binding_status: derivative.dataset_binding_status,
    mqltick_import_helper: 'mt5/HDH_CustomTicksReplace_Import.mq5',
  } as const;

  await atomicWriteFile(resolve(outRoot, 'mt5_derivative_evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  await atomicWriteFile(
    resolve(outRoot, 'repro_command.txt'),
    `npm run mt5 -- --symbol ${symbolArg} --date ${dateUtc} --source-run ${sourceRunArg} --out ${outArg}\n`,
  );
  await atomicWriteFile(
    resolve(outRoot, 'mt5.log'),
    `symbol=${derivative.symbol} date=${derivative.date_utc} git_commit=${gitCommitSha} rows=${derivative.canonical_row_count} logical_row_sha256=${derivative.canonical_logical_row_sha256} mt5_csv_sha256=${written.csv_physical_sha256} contract_sha256=${written.contract_physical_sha256} resumed=${written.resumed_existing}\n`,
  );

  JSON.parse(await readFile(resolve(outRoot, 'mt5_derivative_evidence.json'), 'utf8'));
  JSON.parse(await readFile(written.contract_path, 'utf8'));
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

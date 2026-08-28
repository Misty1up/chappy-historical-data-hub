#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, rename } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { DukascopyNodeAdapter } from './adapters/dukascopy-node-adapter.js';
import { acquireDay, snapshotPathForDay } from './core/acquire-day.js';
import { atomicWriteFile } from './core/atomic-write.js';
import { classifyError } from './core/failure-classification.js';
import { planUtcDays } from './core/job-planner.js';
import { loadLatestAudits, verifyReusableSnapshot } from './core/resume.js';
import { appendJsonl, appendLog, buildSha256Sums, verifySha256Sums } from './core/run-evidence.js';
import { loadSymbolRegistry, resolveSymbol } from './core/symbol-registry.js';
import type { DailyAudit, JobConfig } from './types/contracts.js';

const ADAPTER_VERSION = '0.1.0';
const DUKASCOPY_NODE_VERSION = '1.50.0';
const SOURCE_ADAPTER_EVIDENCE = {
  adapter_id: 'dukascopy-node',
  adapter_version: ADAPTER_VERSION,
  library: 'dukascopy-node',
  library_version: DUKASCOPY_NODE_VERSION,
  feed_type: 'tick',
  utc_offset: 0,
  volumes: true,
  volume_units: 'units',
  ignore_flats: false,
  use_cache: false,
  library_retry_count: 0,
  price_decode: 'dukascopy-node-json-api-multiplier',
} as const;

function parseOptions(args: string[]): Map<string, string | boolean> {
  const map = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'force') {
      map.set(key, true);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    map.set(key, value);
  }
  return map;
}

function required(options: Map<string, string | boolean>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value) throw new Error(`Missing required option --${key}`);
  return value;
}

function intOption(options: Map<string, string | boolean>, key: string, fallback: number, min: number): number {
  const raw = options.get(key);
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error(`--${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`--${key} must be >= ${min}`);
  return value;
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

function failureAudit(dateUtc: string, failureClass: string, note: string): DailyAudit {
  return {
    date_utc: dateUtc,
    status: 'FAIL',
    tick_count: 0,
    first_timestamp_msc: null,
    last_timestamp_msc: null,
    exact_duplicate_count: 0,
    same_timestamp_pair_count: 0,
    out_of_order_count: 0,
    invalid_price_count: 0,
    negative_spread_count: 0,
    null_bid_volume_count: 0,
    null_ask_volume_count: 0,
    snapshot_path: null,
    snapshot_sha256: null,
    failure_class: failureClass,
    note,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function backupIfPresent(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await rename(path, `${path}.backup-${Date.now()}`);
}

async function commandAcquire(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const symbolArg = required(options, 'symbol').toUpperCase();
  const fromArg = required(options, 'from');
  const toArg = required(options, 'to');
  const outArg = required(options, 'out');
  if (isAbsolute(outArg)) throw new Error('--out must be a relative path to avoid recording personal absolute paths');

  const batchSize = intOption(options, 'batch-size', 10, 1);
  const batchPauseMs = intOption(options, 'batch-pause-ms', 1000, 0);
  const maxAttempts = intOption(options, 'max-attempts', 3, 1);
  const force = options.get('force') === true;
  const days = planUtcDays(fromArg, toArg);

  const registryPath = resolve(process.cwd(), 'config', 'symbol_registry.json');
  const registry = await loadSymbolRegistry(registryPath);
  const symbol = resolveSymbol(registry, symbolArg);
  const runRoot = resolve(process.cwd(), outArg);
  await mkdir(resolve(runRoot, 'integrity'), { recursive: true });

  const taskId = `HDH_${symbolArg}_${fromArg}_${toArg}`.replaceAll('-', '');
  const jobConfig: JobConfig = {
    task_id: taskId,
    symbol: symbolArg,
    from_utc: `${fromArg}T00:00:00.000Z`,
    to_utc: `${toArg}T00:00:00.000Z`,
    out_dir: outArg,
    batch_size: batchSize,
    batch_pause_ms: batchPauseMs,
    max_attempts: maxAttempts,
    force,
  };

  const jobPath = resolve(runRoot, 'job_config.json');
  if (await exists(jobPath)) {
    const previous = JSON.parse(await readFile(jobPath, 'utf8')) as JobConfig;
    const comparablePrevious = { ...previous, force: false };
    const comparableCurrent = { ...jobConfig, force: false };
    if (JSON.stringify(comparablePrevious) !== JSON.stringify(comparableCurrent) && !force) {
      throw new Error('Existing run directory job_config does not match requested job; use a new --out path');
    }
  }

  await atomicWriteFile(jobPath, `${JSON.stringify(jobConfig, null, 2)}\n`);
  await atomicWriteFile(resolve(runRoot, 'source_adapter.json'), `${JSON.stringify(SOURCE_ADAPTER_EVIDENCE, null, 2)}\n`);
  await atomicWriteFile(resolve(runRoot, 'symbol_registry_snapshot.json'), `${JSON.stringify({
    schema_version: registry.schema_version,
    symbols: [symbol],
  }, null, 2)}\n`);

  const repro = `npm run hdh -- acquire --symbol ${symbolArg} --from ${fromArg} --to ${toArg} --out ${outArg} --batch-size ${batchSize} --batch-pause-ms ${batchPauseMs} --max-attempts ${maxAttempts}${force ? ' --force' : ''}`;
  await atomicWriteFile(resolve(runRoot, 'repro_command.txt'), `${repro}\n`);

  const runLogPath = resolve(runRoot, 'run.log');
  const auditPath = resolve(runRoot, 'integrity', 'daily_audit.jsonl');
  await appendLog(runLogPath, `run_id=${taskId} git_commit=${gitCommit()} node=${process.version} adapter=dukascopy-node@${DUKASCOPY_NODE_VERSION} symbol=${symbolArg} range=${fromArg}..${toArg} batch_size=${batchSize} batch_pause_ms=${batchPauseMs} max_attempts=${maxAttempts} volume_units=units utc_offset=0 use_cache=false library_retry_count=0`);

  const latestAudits = await loadLatestAudits(auditPath);
  const adapter = new DukascopyNodeAdapter();

  for (const window of days) {
    const snapshotPath = snapshotPathForDay(runRoot, symbol, window.dateUtc);
    const previousAudit = latestAudits.get(window.dateUtc);

    if (!force && previousAudit?.snapshot_path) {
      if (await verifyReusableSnapshot(previousAudit, snapshotPath)) {
        await appendLog(runLogPath, `date=${window.dateUtc} action=resume_skip ticks=${previousAudit.tick_count} hash=${previousAudit.snapshot_sha256}`);
        continue;
      }
    }
    if (force) await backupIfPresent(snapshotPath);

    let finalAudit: DailyAudit | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await appendLog(runLogPath, `date=${window.dateUtc} attempt=${attempt} action=fetch_start`);
      try {
        finalAudit = await acquireDay({
          adapter,
          symbol,
          window,
          runRoot,
          options: { batchSize, pauseBetweenBatchesMs: batchPauseMs },
        });
        await appendLog(runLogPath, `date=${window.dateUtc} attempt=${attempt} action=fetch_end ticks=${finalAudit.tick_count} status=${finalAudit.status} hash=${finalAudit.snapshot_sha256 ?? 'NONE'}`);
        break;
      } catch (error) {
        const failureClass = classifyError(error);
        const message = error instanceof Error ? error.message : String(error);
        await appendLog(runLogPath, `date=${window.dateUtc} attempt=${attempt} action=fetch_error class=${failureClass} message=${JSON.stringify(message)}`);
        if (attempt === maxAttempts) finalAudit = failureAudit(window.dateUtc, failureClass, message);
      }
    }

    if (!finalAudit) throw new Error(`Internal error: no audit produced for ${window.dateUtc}`);
    await appendJsonl(auditPath, finalAudit);
    latestAudits.set(window.dateUtc, finalAudit);
  }

  const audits = days.map(day => latestAudits.get(day.dateUtc) ?? failureAudit(day.dateUtc, 'UNKNOWN', 'Missing audit'));
  const passDays = audits.filter(a => a.status === 'PASS').length;
  const warnDays = audits.filter(a => a.status === 'WARN').length;
  const failDays = audits.filter(a => a.status === 'FAIL').length;
  const tickCountTotal = audits.reduce((sum, audit) => sum + audit.tick_count, 0);

  const csvRows = ['date_utc,status,failure_class,note'];
  for (const audit of audits.filter(a => a.status !== 'PASS')) {
    const esc = (v: string | null) => `"${(v ?? '').replaceAll('"', '""')}"`;
    csvRows.push(`${audit.date_utc},${audit.status},${esc(audit.failure_class)},${esc(audit.note)}`);
  }
  await atomicWriteFile(resolve(runRoot, 'integrity', 'gap_and_failure_report.csv'), `${csvRows.join('\n')}\n`);

  const manifest = {
    schema_version: '0.1.0',
    run_id: taskId,
    git_commit: gitCommit(),
    symbol: symbolArg,
    source: 'dukascopy',
    source_adapter: 'dukascopy-node',
    source_adapter_version: DUKASCOPY_NODE_VERSION,
    requested_from_utc: `${fromArg}T00:00:00.000Z`,
    requested_to_utc: `${toArg}T00:00:00.000Z`,
    acquisition_unit: 'UTC_DAY',
    total_days: days.length,
    pass_days: passDays,
    warn_days: warnDays,
    fail_days: failDays,
    tick_count_total: tickCountTotal,
    precision_status: symbol.precision_status,
    canonical_promotion_allowed: symbol.precision_status === 'VERIFIED' && failDays === 0,
    phase_1_source_snapshot_only: true,
    generated_at_utc: new Date().toISOString(),
  };
  await atomicWriteFile(resolve(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await buildSha256Sums(runRoot);
  await appendLog(runLogPath, `run_complete pass_days=${passDays} warn_days=${warnDays} fail_days=${failDays} ticks=${tickCountTotal} canonical_promotion_allowed=${manifest.canonical_promotion_allowed}`);

  console.log(JSON.stringify(manifest, null, 2));
  if (failDays > 0) process.exitCode = 2;
}

async function commandStatus(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runArg = required(options, 'run');
  if (isAbsolute(runArg)) throw new Error('--run must be relative');
  console.log(await readFile(resolve(process.cwd(), runArg, 'manifest.json'), 'utf8'));
}

async function commandVerify(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runArg = required(options, 'run');
  if (isAbsolute(runArg)) throw new Error('--run must be relative');
  const result = await verifySha256Sums(resolve(process.cwd(), runArg));
  console.log(JSON.stringify(result, null, 2));
  if (result.mismatches.length) process.exitCode = 3;
}

async function commandRehash(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runArg = required(options, 'run');
  if (isAbsolute(runArg)) throw new Error('--run must be relative');
  await buildSha256Sums(resolve(process.cwd(), runArg));
  console.log('SHA256SUMS.txt regenerated');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'acquire') return await commandAcquire(args);
  if (command === 'status') return await commandStatus(args);
  if (command === 'verify') return await commandVerify(args);
  if (command === 'rehash') return await commandRehash(args);
  throw new Error('Usage: hdh <acquire|status|verify|rehash> [options]');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { planUtcDays } from '../core/job-planner.js';
import type { WebJobRequest } from '../web/contract.js';

export interface Phase4ExecutionPaths {
  root: string;
  sourceRun: string;
  precision: string;
  canonical: string;
  mt5: string;
  packet: string;
}

export interface Phase4ExecutionPlan {
  request: WebJobRequest;
  paths: Phase4ExecutionPaths;
  utcDays: string[];
  commands: string[][];
}

function requestDatePrefix(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? 'INVALID_DATE';
}

function requireMidnight(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())
    || parsed.getUTCHours() !== 0
    || parsed.getUTCMinutes() !== 0
    || parsed.getUTCSeconds() !== 0
    || parsed.getUTCMilliseconds() !== 0) {
    throw new Error(`${field} must be an exact UTC midnight for Phase 4 P4.3 execution`);
  }
  return parsed.toISOString().slice(0, 10);
}

export function phase4ExecutionRootForRequest(request: WebJobRequest, root = '.hdh-phase4/execution'): string {
  const safeKey = `${request.symbol}-${requestDatePrefix(request.requested_from_utc)}-${requestDatePrefix(request.requested_to_utc)}-${request.mode}`
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${root}/${safeKey}`;
}

export function buildPhase4ExecutionPlan(request: WebJobRequest, root = '.hdh-phase4/execution'): Phase4ExecutionPlan {
  const fromDate = requireMidnight(request.requested_from_utc, 'requested_from_utc');
  const toDate = requireMidnight(request.requested_to_utc, 'requested_to_utc');
  const days = planUtcDays(fromDate, toDate).map(day => day.dateUtc);
  if (days.length === 0) throw new Error('Phase 4 execution range contains no UTC days');

  const base = phase4ExecutionRootForRequest(request, root);
  const paths: Phase4ExecutionPaths = {
    root: base,
    sourceRun: `${base}/source`,
    precision: `${base}/precision`,
    canonical: `${base}/canonical-work`,
    mt5: `${base}/mt5-work`,
    packet: `${base}/packet`
  };

  const commands: string[][] = [[
    'dist/src/cli.js', 'acquire', '--symbol', request.symbol, '--from', fromDate, '--to', toDate, '--out', paths.sourceRun
  ]];

  if (request.mode === 'QUICK_DOWNLOAD') return { request, paths, utcDays: days, commands };

  commands.push([
    'dist/src/precision-cli.js', '--symbol', request.symbol, '--date', days[0]!, '--source-run', paths.sourceRun, '--out', paths.precision
  ]);
  for (const date of days) {
    commands.push([
      'dist/src/parquet-cli.js', '--symbol', request.symbol, '--date', date, '--source-run', paths.sourceRun, '--out', paths.canonical
    ]);
    // Dataset Packet v0.1 verifies this deterministic derivative as a binding to the same Canonical rows.
    // This is not an MT5 terminal/Strategy Tester parity run.
    commands.push([
      'dist/src/mt5-cli.js', '--symbol', request.symbol, '--date', date, '--source-run', paths.sourceRun, '--out', paths.mt5
    ]);
  }
  commands.push([
    'dist/src/packet-cli.js', '--symbol', request.symbol,
    '--source-run', paths.sourceRun,
    '--precision-evidence', `${paths.precision}/precision_evidence.json`,
    '--canonical-root', paths.canonical,
    '--mt5-root', paths.mt5,
    '--out', paths.packet
  ]);
  return { request, paths, utcDays: days, commands };
}

export async function executePhase4Plan(plan: Phase4ExecutionPlan): Promise<void> {
  await mkdir(resolve(plan.paths.root), { recursive: true });
  for (const args of plan.commands) {
    execFileSync(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit' });
  }
  if (plan.request.mode !== 'QUICK_DOWNLOAD') {
    JSON.parse(await readFile(resolve(plan.paths.packet, 'manifest.json'), 'utf8'));
  } else {
    JSON.parse(await readFile(resolve(plan.paths.sourceRun, 'manifest.json'), 'utf8'));
  }
}

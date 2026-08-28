import { relative, resolve } from 'node:path';
import type { AcquisitionAdapter } from '../adapters/acquisition-adapter.js';
import type { DailyAudit, FetchTicksOptions, SymbolRegistryEntry, UtcDayWindow } from '../types/contracts.js';
import { auditSourceTicks } from './integrity-audit.js';
import { writeSourceSnapshot } from './source-snapshot.js';
import { sha256File } from './hash.js';

export interface AcquireDayInput {
  adapter: AcquisitionAdapter;
  symbol: SymbolRegistryEntry;
  window: UtcDayWindow;
  runRoot: string;
  options: FetchTicksOptions;
}

export function snapshotPathForDay(runRoot: string, symbol: SymbolRegistryEntry, dateUtc: string): string {
  const [year, month] = dateUtc.split('-');
  return resolve(
    runRoot,
    'source_ticks',
    'dukascopy-node',
    symbol.canonical_symbol,
    year!,
    month!,
    `${dateUtc}.jsonl.gz`,
  );
}

export async function acquireDay(input: AcquireDayInput): Promise<DailyAudit> {
  const ticks = await input.adapter.fetchTicks(
    input.symbol,
    input.window.fromUtc,
    input.window.toUtc,
    input.options,
  );

  const audit = auditSourceTicks(input.window.dateUtc, ticks, input.window);
  if (audit.status !== 'PASS') return audit;

  const snapshotPath = snapshotPathForDay(input.runRoot, input.symbol, input.window.dateUtc);
  await writeSourceSnapshot(snapshotPath, ticks);
  audit.snapshot_path = relative(input.runRoot, snapshotPath).replaceAll('\\', '/');
  audit.snapshot_sha256 = await sha256File(snapshotPath);
  return audit;
}

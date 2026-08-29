import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../core/atomic-write.js';
import { sha256File } from '../core/hash.js';
import type { Mt5TickDerivativeDay } from './types.js';

export interface Mt5DerivativeWriteResult {
  csv_path: string;
  csv_physical_sha256: string;
  csv_file_size_bytes: number;
  contract_path: string;
  contract_physical_sha256: string;
  contract_file_size_bytes: number;
  resumed_existing: boolean;
}

export function mt5DerivativeCsvPathForDay(outRoot: string, symbol: string, dateUtc: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateUtc);
  if (!match) throw new Error(`dateUtc must be YYYY-MM-DD: ${dateUtc}`);
  return resolve(outRoot, 'mt5', 'ticks', symbol, match[1]!, match[2]!, `${dateUtc}.ticks.csv`);
}

export function mt5DerivativeContractPathForDay(outRoot: string, symbol: string, dateUtc: string): string {
  return mt5DerivativeCsvPathForDay(outRoot, symbol, dateUtc).replace(/\.ticks\.csv$/, '.contract.json');
}

export function serializeMt5DerivativeCsv(day: Mt5TickDerivativeDay): string {
  const lines = ['time_msc,bid,ask,bid_scaled,ask_scaled,source_seq'];
  for (const row of day.rows) {
    lines.push(
      `${row.time_msc.toString()},${row.bid},${row.ask},${row.bid_scaled.toString()},${row.ask_scaled.toString()},${row.source_seq}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function serializeMt5DerivativeContract(day: Mt5TickDerivativeDay): string {
  const contract = {
    schema_version: day.schema_version,
    profile_id: day.profile_id,
    symbol: day.symbol,
    date_utc: day.date_utc,
    price_digits: day.price_digits,
    price_scale: day.price_scale,
    source_snapshot_sha256: day.source_snapshot_sha256,
    canonical_logical_row_sha256: day.canonical_logical_row_sha256,
    canonical_row_count: day.canonical_row_count,
    from_msc: day.from_msc.toString(),
    to_msc: day.to_msc.toString(),
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
    order_policy: day.order_policy,
    same_timestamp_policy: day.same_timestamp_policy,
    dedupe_applied: day.dedupe_applied,
    gap_fill_applied: day.gap_fill_applied,
    bid_ask_mapping: day.bid_ask_mapping,
    volume_mapping_policy: day.volume_mapping_policy,
    dataset_binding_status: day.dataset_binding_status,
  } as const;
  return `${JSON.stringify(contract, null, 2)}\n`;
}

async function existingText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeOrVerifyExact(path: string, expected: string): Promise<boolean> {
  const existing = await existingText(path);
  if (existing !== null) {
    if (existing !== expected) throw new Error(`Existing MT5 derivative artifact conflicts with deterministic output: ${path}`);
    return true;
  }
  await atomicWriteFile(path, expected);
  const readback = await readFile(path, 'utf8');
  if (readback !== expected) throw new Error(`MT5 derivative readback mismatch after write: ${path}`);
  return false;
}

export async function writeMt5DerivativeDay(day: Mt5TickDerivativeDay, outRoot: string): Promise<Mt5DerivativeWriteResult> {
  const csvPath = mt5DerivativeCsvPathForDay(outRoot, day.symbol, day.date_utc);
  const contractPath = mt5DerivativeContractPathForDay(outRoot, day.symbol, day.date_utc);
  const csv = serializeMt5DerivativeCsv(day);
  const contract = serializeMt5DerivativeContract(day);

  const csvResumed = await writeOrVerifyExact(csvPath, csv);
  const contractResumed = await writeOrVerifyExact(contractPath, contract);
  const csvStat = await stat(csvPath);
  const contractStat = await stat(contractPath);

  return {
    csv_path: csvPath,
    csv_physical_sha256: await sha256File(csvPath),
    csv_file_size_bytes: csvStat.size,
    contract_path: contractPath,
    contract_physical_sha256: await sha256File(contractPath),
    contract_file_size_bytes: contractStat.size,
    resumed_existing: csvResumed && contractResumed,
  };
}

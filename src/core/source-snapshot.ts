import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import type { SerializableSourceTick, SourceTick } from '../types/contracts.js';
import { atomicWriteFile, type BinaryBytes } from './atomic-write.js';

export function toSerializableSourceTick(tick: SourceTick): SerializableSourceTick {
  return {
    timestamp_msc: tick.timestamp_msc.toString(10),
    bid: tick.bid,
    ask: tick.ask,
    bid_volume: tick.bid_volume,
    ask_volume: tick.ask_volume,
    source_seq: tick.source_seq,
  };
}

export function serializeSourceTicksJsonl(ticks: SourceTick[]): string {
  if (ticks.length === 0) return '';
  return `${ticks.map(tick => JSON.stringify(toSerializableSourceTick(tick))).join('\n')}\n`;
}

function toBinaryBytes(data: Uint8Array): BinaryBytes {
  return new Uint8Array(data);
}

export function gzipSourceTicks(ticks: SourceTick[]): BinaryBytes {
  const jsonl = serializeSourceTicksJsonl(ticks);
  return toBinaryBytes(gzipSync(jsonl, { level: 9, mtime: 0 } as never));
}

export async function writeSourceSnapshot(path: string, ticks: SourceTick[]): Promise<void> {
  await atomicWriteFile(path, gzipSourceTicks(ticks));
}

export async function readSourceSnapshot(path: string): Promise<SerializableSourceTick[]> {
  const compressed = toBinaryBytes(await readFile(path));
  const text = gunzipSync(compressed).toString('utf8');
  if (text.length === 0) return [];
  return text.trimEnd().split('\n').map(line => JSON.parse(line) as SerializableSourceTick);
}

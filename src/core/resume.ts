import { access, readFile } from 'node:fs/promises';
import type { DailyAudit } from '../types/contracts.js';
import { sha256File } from './hash.js';

export async function loadLatestAudits(path: string): Promise<Map<string, DailyAudit>> {
  const result = new Map<string, DailyAudit>();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const audit = JSON.parse(line) as DailyAudit;
    result.set(audit.date_utc, audit);
  }
  return result;
}

export async function verifyReusableSnapshot(audit: DailyAudit | undefined, absoluteSnapshotPath: string): Promise<boolean> {
  if (!audit || audit.status !== 'PASS' || !audit.snapshot_sha256 || !audit.snapshot_path) return false;
  try {
    await access(absoluteSnapshotPath);
  } catch {
    return false;
  }
  const actual = await sha256File(absoluteSnapshotPath);
  if (actual !== audit.snapshot_sha256) {
    throw new Error(`HASH_MISMATCH for ${audit.date_utc}: expected=${audit.snapshot_sha256} actual=${actual}`);
  }
  return true;
}

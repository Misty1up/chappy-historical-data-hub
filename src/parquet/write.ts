import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parquetWriteFile } from 'hyparquet-writer';
import type { CanonicalDayResult } from '../canonical/types.js';
import { sha256File } from '../core/hash.js';
import {
  CANONICAL_PARQUET_PROFILE,
  PARQUET_READER_PACKAGE,
  PARQUET_READER_VERSION,
  PARQUET_WRITER_PACKAGE,
  PARQUET_WRITER_VERSION,
  canonicalParquetColumnData,
} from './profile.js';
import { verifyCanonicalParquetFile, type CanonicalParquetVerification } from './verify.js';

export interface CanonicalParquetWriteResult {
  path: string;
  physical_sha256: string;
  file_size_bytes: number;
  resumed_existing: boolean;
  writer_package: typeof PARQUET_WRITER_PACKAGE;
  writer_version: typeof PARQUET_WRITER_VERSION;
  reader_package: typeof PARQUET_READER_PACKAGE;
  reader_version: typeof PARQUET_READER_VERSION;
  profile: typeof CANONICAL_PARQUET_PROFILE;
  verification: CanonicalParquetVerification;
}

export function canonicalParquetPathForDay(outRoot: string, symbol: string, dateUtc: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateUtc);
  if (!match) throw new Error(`dateUtc must be YYYY-MM-DD: ${dateUtc}`);
  return resolve(outRoot, 'canonical', symbol, match[1]!, match[2]!, `${dateUtc}.parquet`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectVerifiedFile(path: string, canonical: CanonicalDayResult): Promise<CanonicalParquetWriteResult> {
  const verification = await verifyCanonicalParquetFile(path, canonical.rows, canonical.logical_row_sha256);
  const fileStat = await stat(path);
  return {
    path,
    physical_sha256: await sha256File(path),
    file_size_bytes: fileStat.size,
    resumed_existing: true,
    writer_package: PARQUET_WRITER_PACKAGE,
    writer_version: PARQUET_WRITER_VERSION,
    reader_package: PARQUET_READER_PACKAGE,
    reader_version: PARQUET_READER_VERSION,
    profile: CANONICAL_PARQUET_PROFILE,
    verification,
  };
}

export async function writeCanonicalParquetDay(
  canonical: CanonicalDayResult,
  finalPath: string,
): Promise<CanonicalParquetWriteResult> {
  if (await fileExists(finalPath)) return inspectVerifiedFile(finalPath, canonical);

  await mkdir(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    parquetWriteFile({
      filename: tempPath,
      columnData: canonicalParquetColumnData(canonical.rows),
      codec: CANONICAL_PARQUET_PROFILE.codec,
      statistics: CANONICAL_PARQUET_PROFILE.statistics,
      rowGroupSize: CANONICAL_PARQUET_PROFILE.row_group_size,
    });

    const verification = await verifyCanonicalParquetFile(tempPath, canonical.rows, canonical.logical_row_sha256);
    const physicalSha256BeforePromote = await sha256File(tempPath);
    const tempStat = await stat(tempPath);

    if (await fileExists(finalPath)) {
      throw new Error(`Canonical Parquet destination appeared during build: ${finalPath}`);
    }
    await rename(tempPath, finalPath);

    const physicalSha256AfterPromote = await sha256File(finalPath);
    if (physicalSha256AfterPromote !== physicalSha256BeforePromote) {
      throw new Error(`Canonical Parquet SHA changed during atomic rename: before=${physicalSha256BeforePromote} after=${physicalSha256AfterPromote}`);
    }

    return {
      path: finalPath,
      physical_sha256: physicalSha256AfterPromote,
      file_size_bytes: tempStat.size,
      resumed_existing: false,
      writer_package: PARQUET_WRITER_PACKAGE,
      writer_version: PARQUET_WRITER_VERSION,
      reader_package: PARQUET_READER_PACKAGE,
      reader_version: PARQUET_READER_VERSION,
      profile: CANONICAL_PARQUET_PROFILE,
      verification,
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

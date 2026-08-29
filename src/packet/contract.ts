import { sha256Text } from '../core/hash.js';

export const DATASET_ID_PROFILE = 'HDH_DATASET_ID_V1' as const;
export const DATASET_ID_PREFIX = 'HDH_DATASET_V1_' as const;
export const CANONICAL_SCHEMA_VERSION = '0.1' as const;
export const DATASET_PACKET_MANIFEST_SCHEMA_VERSION = '0.1.0' as const;

export interface DatasetIdentityInput {
  canonical_schema_version: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  source_hash_root: string;
  precision_evidence_sha256: string;
  generator_git_commit: string;
}

export interface HashRootEntry {
  key: string;
  sha256: string;
}

function assertSingleLine(value: string, label: string): void {
  if (!value || /[\r\n]/.test(value)) throw new Error(`${label} must be a non-empty single-line value`);
}

export function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex`);
}

export function assertGitCommit(value: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error('generator_git_commit must be an exact Git commit hex SHA');
}

export function serializeDatasetIdentity(input: DatasetIdentityInput): string {
  assertSingleLine(input.canonical_schema_version, 'canonical_schema_version');
  if (!/^[A-Z0-9._-]+$/.test(input.symbol)) throw new Error(`Invalid dataset identity symbol: ${input.symbol}`);
  assertSingleLine(input.requested_from_utc, 'requested_from_utc');
  assertSingleLine(input.requested_to_utc, 'requested_to_utc');
  assertSha256(input.source_hash_root, 'source_hash_root');
  assertSha256(input.precision_evidence_sha256, 'precision_evidence_sha256');
  assertGitCommit(input.generator_git_commit);

  return [
    DATASET_ID_PROFILE,
    `canonical_schema_version=${input.canonical_schema_version}`,
    `symbol=${input.symbol}`,
    `requested_from_utc=${input.requested_from_utc}`,
    `requested_to_utc=${input.requested_to_utc}`,
    `source_hash_root=${input.source_hash_root}`,
    `precision_evidence_sha256=${input.precision_evidence_sha256}`,
    `generator_git_commit=${input.generator_git_commit}`,
    '',
  ].join('\n');
}

export function datasetIdFor(input: DatasetIdentityInput): string {
  return `${DATASET_ID_PREFIX}${sha256Text(serializeDatasetIdentity(input))}`;
}

export function hashEntriesRoot(entries: readonly HashRootEntry[]): string {
  const sorted = entries
    .map(entry => ({ ...entry }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const seen = new Set<string>();
  let input = '';
  for (const entry of sorted) {
    assertSingleLine(entry.key, 'hash root key');
    assertSha256(entry.sha256, `hash for ${entry.key}`);
    if (seen.has(entry.key)) throw new Error(`Duplicate hash root key: ${entry.key}`);
    seen.add(entry.key);
    input += `${entry.key}  ${entry.sha256}\n`;
  }
  return sha256Text(input);
}

export function sameTimestampGroupCount(rows: readonly { timestamp_msc: bigint }[]): number {
  let groups = 0;
  let insideGroup = false;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.timestamp_msc === rows[index - 1]!.timestamp_msc) {
      if (!insideGroup) groups += 1;
      insideGroup = true;
    } else {
      insideGroup = false;
    }
  }
  return groups;
}

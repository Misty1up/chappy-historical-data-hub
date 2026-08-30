import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WebJobRequest } from '../web/contract.js';
import type { Phase4ActionResult } from './result.js';

export const PHASE4_ARTIFACT_CAP_BYTES = 200 * 1024 * 1024;
export const PHASE4_ARTIFACT_RETENTION_DAYS = 1;

export interface ArtifactSizeDecision {
  status: 'PASS' | 'HOLD';
  total_bytes: number;
  failure_code: null | 'ARTIFACT_TOO_LARGE';
  local_fallback_required: boolean;
}

async function measurePath(path: string): Promise<number> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Artifact inventory refuses symbolic link: ${path}`);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error(`Artifact inventory supports files/directories only: ${path}`);

  let total = 0;
  const entries = (await readdir(path)).sort((a, b) => a.localeCompare(b));
  for (const entry of entries) total += await measurePath(join(path, entry));
  return total;
}

export async function measureArtifactInventory(paths: string[]): Promise<number> {
  if (paths.length === 0) throw new Error('Artifact inventory must not be empty');
  let total = 0;
  const seen = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(path);
    if (seen.has(absolute)) throw new Error(`Duplicate Artifact inventory path: ${path}`);
    seen.add(absolute);
    total += await measurePath(absolute);
  }
  return total;
}

export function assessArtifactSize(totalBytes: number, capBytes = PHASE4_ARTIFACT_CAP_BYTES): ArtifactSizeDecision {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error(`Invalid Artifact byte count: ${totalBytes}`);
  if (!Number.isSafeInteger(capBytes) || capBytes <= 0) throw new Error(`Invalid Artifact cap: ${capBytes}`);
  if (totalBytes > capBytes) {
    return {
      status: 'HOLD',
      total_bytes: totalBytes,
      failure_code: 'ARTIFACT_TOO_LARGE',
      local_fallback_required: true,
    };
  }
  return { status: 'PASS', total_bytes: totalBytes, failure_code: null, local_fallback_required: false };
}

export function artifactNameForRequest(request: WebJobRequest, runId: string): string {
  const from = request.requested_from_utc.slice(0, 10);
  const to = request.requested_to_utc.slice(0, 10);
  return `hdh-${request.symbol}-${from}-${to}-${request.mode}-${runId}`.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function attachTemporaryArtifactReference(
  result: Phase4ActionResult,
  artifactName: string,
  artifactReference: string,
): Phase4ActionResult {
  if (result.status !== 'PASS') throw new Error('Temporary success Artifact reference may be attached only to PASS');
  return {
    ...result,
    packet_artifact_name: artifactName,
    packet_artifact_reference: artifactReference,
  };
}

export function clearSuccessMetadataForTerminalResult(
  result: Phase4ActionResult,
  status: 'FAIL' | 'HOLD',
  failureCode: string,
  failureDetail: string,
  localFallbackRequired: boolean,
): Phase4ActionResult {
  return {
    action_result_schema_version: result.action_result_schema_version,
    request: result.request,
    workflow_run_id: result.workflow_run_id,
    workflow_run_attempt: result.workflow_run_attempt,
    repository_commit: result.repository_commit,
    status,
    started_at_utc: result.started_at_utc,
    completed_at_utc: new Date().toISOString(),
    dataset_id: null,
    symbol: result.symbol,
    requested_from_utc: result.requested_from_utc,
    requested_to_utc: result.requested_to_utc,
    mode: result.mode,
    tick_count_total: null,
    source_hash_root: null,
    canonical_logical_hash_root: null,
    integrity_status: status,
    canonical_promotion_allowed: false,
    packet_artifact_name: null,
    packet_artifact_reference: null,
    failure_code: failureCode,
    failure_detail: failureDetail,
    local_fallback_required: localFallbackRequired,
    is_fixture: false,
  };
}

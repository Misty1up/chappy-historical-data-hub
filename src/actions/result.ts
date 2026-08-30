import type { DatasetPacketManifest } from '../packet/types.js';
import type { WebJobRequest } from '../web/contract.js';

export const ACTION_RESULT_SCHEMA_VERSION = '0.1.0' as const;

export interface Phase4ResultContext {
  workflow_run_id: string;
  workflow_run_attempt: string;
  repository_commit: string;
  started_at_utc: string;
  completed_at_utc: string;
}

export interface Phase4QuickManifest {
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  tick_count_total: number;
  source_hash_root: string;
  integrity_status: string;
  canonical_promotion_allowed: boolean;
}

export interface Mt5ParityPacketBinding {
  binding_status: 'PASS';
  parity_scope: 'PACKET_BINDING_ONLY';
  dataset_id: string;
  source_hash_root: string;
  canonical_logical_hash_root: string;
  mt5_derivative_hash_root: string;
  terminal_mt5_parity_executed: false;
}

export interface Phase4ActionResult {
  action_result_schema_version: typeof ACTION_RESULT_SCHEMA_VERSION;
  request: WebJobRequest;
  workflow_run_id: string;
  workflow_run_attempt: string;
  repository_commit: string;
  status: 'PASS' | 'FAIL' | 'HOLD';
  started_at_utc: string;
  completed_at_utc: string;
  dataset_id: string | null;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  mode: WebJobRequest['mode'];
  tick_count_total: number | null;
  source_hash_root: string | null;
  canonical_logical_hash_root: string | null;
  integrity_status: string;
  canonical_promotion_allowed: boolean;
  packet_artifact_name: string | null;
  packet_artifact_reference: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  local_fallback_required: boolean;
  is_fixture: false;
  mt5_parity_binding?: Mt5ParityPacketBinding;
}

function assertRequestBinding(request: WebJobRequest, manifest: { symbol: string; requested_from_utc: string; requested_to_utc: string }): void {
  if (manifest.symbol !== request.symbol) throw new Error(`Result manifest symbol mismatch: request=${request.symbol} manifest=${manifest.symbol}`);
  if (manifest.requested_from_utc !== request.requested_from_utc) {
    throw new Error(`Result manifest requested_from_utc mismatch: request=${request.requested_from_utc} manifest=${manifest.requested_from_utc}`);
  }
  if (manifest.requested_to_utc !== request.requested_to_utc) {
    throw new Error(`Result manifest requested_to_utc mismatch: request=${request.requested_to_utc} manifest=${manifest.requested_to_utc}`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a 64-char lowercase SHA-256`);
}

function assertResearchManifest(request: WebJobRequest, manifest: DatasetPacketManifest): void {
  assertRequestBinding(request, manifest);
  if (manifest.integrity_status !== 'PASS') throw new Error(`Research result integrity is not PASS: ${manifest.integrity_status}`);
  if (manifest.canonical_promotion_allowed !== true) throw new Error('Research result is not Canonical-promotion eligible');
  if (!manifest.dataset_id.startsWith('HDH_DATASET_V1_')) throw new Error(`Unexpected dataset_id profile: ${manifest.dataset_id}`);
  assertSha256(manifest.source_hash_root, 'source_hash_root');
  assertSha256(manifest.canonical_logical_hash_root, 'canonical_logical_hash_root');
  assertSha256(manifest.mt5_derivative_hash_root, 'mt5_derivative_hash_root');
}

export function buildPassActionResult(
  request: WebJobRequest,
  manifest: Phase4QuickManifest | DatasetPacketManifest,
  context: Phase4ResultContext,
): Phase4ActionResult {
  assertRequestBinding(request, manifest);

  if (request.mode === 'QUICK_DOWNLOAD') {
    const quick = manifest as Phase4QuickManifest;
    if (quick.integrity_status !== 'PASS') throw new Error(`QUICK_DOWNLOAD result integrity is not PASS: ${quick.integrity_status}`);
    assertSha256(quick.source_hash_root, 'source_hash_root');
    return {
      action_result_schema_version: ACTION_RESULT_SCHEMA_VERSION,
      request,
      ...context,
      status: 'PASS',
      dataset_id: null,
      symbol: request.symbol,
      requested_from_utc: request.requested_from_utc,
      requested_to_utc: request.requested_to_utc,
      mode: request.mode,
      tick_count_total: quick.tick_count_total,
      source_hash_root: quick.source_hash_root,
      canonical_logical_hash_root: null,
      integrity_status: quick.integrity_status,
      canonical_promotion_allowed: false,
      packet_artifact_name: null,
      packet_artifact_reference: null,
      failure_code: null,
      failure_detail: null,
      local_fallback_required: false,
      is_fixture: false,
    };
  }

  const packet = manifest as DatasetPacketManifest;
  assertResearchManifest(request, packet);
  const result: Phase4ActionResult = {
    action_result_schema_version: ACTION_RESULT_SCHEMA_VERSION,
    request,
    ...context,
    status: 'PASS',
    dataset_id: packet.dataset_id,
    symbol: packet.symbol,
    requested_from_utc: packet.requested_from_utc,
    requested_to_utc: packet.requested_to_utc,
    mode: request.mode,
    tick_count_total: packet.tick_count_total,
    source_hash_root: packet.source_hash_root,
    canonical_logical_hash_root: packet.canonical_logical_hash_root,
    integrity_status: packet.integrity_status,
    canonical_promotion_allowed: packet.canonical_promotion_allowed,
    packet_artifact_name: null,
    packet_artifact_reference: null,
    failure_code: null,
    failure_detail: null,
    local_fallback_required: false,
    is_fixture: false,
  };

  if (request.mode === 'MT5_PARITY_MASTER') {
    result.mt5_parity_binding = {
      binding_status: 'PASS',
      parity_scope: 'PACKET_BINDING_ONLY',
      dataset_id: packet.dataset_id,
      source_hash_root: packet.source_hash_root,
      canonical_logical_hash_root: packet.canonical_logical_hash_root,
      mt5_derivative_hash_root: packet.mt5_derivative_hash_root,
      terminal_mt5_parity_executed: false,
    };
  }
  return result;
}

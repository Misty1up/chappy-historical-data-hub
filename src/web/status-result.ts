import type { WebJobRequest } from './contract.js';

export type WebJobStatus = 'DRAFT' | 'VALIDATED' | 'QUEUED' | 'RUNNING' | 'PASS' | 'FAIL' | 'HOLD';

export interface WebExecutionResult {
  dataset_id: string;
  symbol: string;
  requested_from_utc: string;
  requested_to_utc: string;
  tick_count_total: number;
  source_hash_root: string;
  canonical_logical_hash_root: string;
  integrity_status: 'PASS' | 'FAIL' | 'HOLD';
  canonical_promotion_allowed: boolean;
  packet_artifact_reference: string;
  is_fixture: boolean;
}

export interface WebJobView {
  status: WebJobStatus;
  detail: string;
  result?: WebExecutionResult;
}

const FIXTURE_SOURCE_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const FIXTURE_CANONICAL_HASH = '2222222222222222222222222222222222222222222222222222222222222222';

export function isTerminalWebJobStatus(status: WebJobStatus): boolean {
  return status === 'PASS' || status === 'FAIL' || status === 'HOLD';
}

export function isSuccessfulWebJobView(view: WebJobView): boolean {
  return view.status === 'PASS' && view.result?.integrity_status === 'PASS' && view.result.canonical_promotion_allowed === true;
}

export function createSyntheticJobFixture(request: WebJobRequest, scenario: 'PASS' | 'FAIL' | 'HOLD'): WebJobView {
  if (scenario === 'PASS') {
    return {
      status: 'PASS',
      detail: 'Synthetic execution fixture. No Canonical authority is created by this browser preview.',
      result: {
        dataset_id: `FIXTURE_ONLY_${request.symbol}_${request.requested_from_utc.slice(0, 10)}`,
        symbol: request.symbol,
        requested_from_utc: request.requested_from_utc,
        requested_to_utc: request.requested_to_utc,
        tick_count_total: request.symbol === 'XAUUSD' ? 404125 : 65395,
        source_hash_root: FIXTURE_SOURCE_HASH,
        canonical_logical_hash_root: FIXTURE_CANONICAL_HASH,
        integrity_status: 'PASS',
        canonical_promotion_allowed: false,
        packet_artifact_reference: `fixture://dataset-packet/${request.symbol}`,
        is_fixture: true
      }
    };
  }

  if (scenario === 'HOLD') {
    return {
      status: 'HOLD',
      detail: 'Synthetic HOLD fixture: verification evidence is incomplete. This is not a successful job.'
    };
  }

  return {
    status: 'FAIL',
    detail: 'Synthetic FAIL fixture: execution failed integrity validation. This is not a successful job.'
  };
}

export function assertWebJobView(view: WebJobView): void {
  if (view.status === 'PASS' && !view.result) {
    throw new Error('PASS status requires result metadata');
  }
  if (view.result && !isTerminalWebJobStatus(view.status)) {
    throw new Error('result metadata is only allowed on terminal fixture states');
  }
  if (!view.result) return;
  if (view.result.is_fixture !== true) {
    throw new Error('Phase 3 fixture model only accepts explicitly marked synthetic results');
  }
  if (view.result.canonical_promotion_allowed !== false) {
    throw new Error('Phase 3 Web fixtures must never allow Canonical promotion');
  }
  if (!view.result.dataset_id.startsWith('FIXTURE_ONLY_')) {
    throw new Error('Phase 3 fixture dataset_id must be visibly non-Canonical');
  }
  if (!view.result.packet_artifact_reference.startsWith('fixture://')) {
    throw new Error('Phase 3 fixture packet reference must use fixture://');
  }
}

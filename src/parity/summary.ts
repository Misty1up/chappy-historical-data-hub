import type { Phase6ComparatorProfile } from './comparator-profile.js';
import type { Phase6TraceComparison } from './comparator.js';
import {
  PHASE6_PARITY_LAYERS,
  phase6LayerEventCounts,
  phase6TraceRootSha256,
  type Phase6ParityLayer,
  type Phase6TraceEvent,
} from './trace-contract.js';

export const PHASE6_PARITY_SUMMARY_SCHEMA_VERSION = 'HDH_P6_PARITY_SUMMARY_V1' as const;

export interface Phase6ParitySummary {
  parity_summary_schema_version: typeof PHASE6_PARITY_SUMMARY_SCHEMA_VERSION;
  parity_run_id: string;
  comparator_profile_id: string;
  comparator_profile_sha256: string;
  status: 'PASS' | 'FAIL';
  numba_trace_root_sha256: string;
  mt5_trace_root_sha256: string;
  event_counts: {
    numba_total: number;
    mt5_total: number;
    numba_by_layer: Record<Phase6ParityLayer, number>;
    mt5_by_layer: Record<Phase6ParityLayer, number>;
  };
  mismatch_count_total: number;
  layer_results: Record<Phase6ParityLayer, 'PASS' | 'FAIL'>;
  first_divergence: null | {
    layer: Phase6ParityLayer;
    classification: Phase6ParityLayer;
    canonical_ordinal: number | null;
    timestamp_msc: number | null;
    event_seq: number | null;
    bar_seq: number | null;
    signal_seq: number | null;
    intent_seq: number | null;
    parity_trade_id: string | null;
    field_path: string;
    comparator: string;
    numba_value_sha256: string;
    mt5_value_sha256: string;
    previous_matching_checkpoint: { layer: Phase6ParityLayer; event_seq: number; canonical_ordinal: number | null; timestamp_msc: number | null } | null;
  };
}

export function buildPhase6ParitySummary(
  comparison: Phase6TraceComparison,
  numbaTrace: readonly Phase6TraceEvent[],
  mt5Trace: readonly Phase6TraceEvent[],
  profile: Phase6ComparatorProfile,
): Phase6ParitySummary {
  const layerResults = {} as Record<Phase6ParityLayer, 'PASS' | 'FAIL'>;
  for (const layer of PHASE6_PARITY_LAYERS) layerResults[layer] = comparison.mismatch_count_by_layer[layer] === 0 ? 'PASS' : 'FAIL';
  const first = comparison.first_divergence;
  return {
    parity_summary_schema_version: PHASE6_PARITY_SUMMARY_SCHEMA_VERSION,
    parity_run_id: comparison.parity_run_id,
    comparator_profile_id: profile.comparator_profile_id,
    comparator_profile_sha256: profile.comparator_profile_sha256,
    status: comparison.status,
    numba_trace_root_sha256: phase6TraceRootSha256(numbaTrace),
    mt5_trace_root_sha256: phase6TraceRootSha256(mt5Trace),
    event_counts: {
      numba_total: numbaTrace.length,
      mt5_total: mt5Trace.length,
      numba_by_layer: phase6LayerEventCounts(numbaTrace),
      mt5_by_layer: phase6LayerEventCounts(mt5Trace),
    },
    mismatch_count_total: comparison.mismatch_count_total,
    layer_results: layerResults,
    first_divergence: first === null ? null : {
      layer: first.layer,
      classification: first.classification,
      canonical_ordinal: first.canonical_ordinal,
      timestamp_msc: first.timestamp_msc,
      event_seq: first.event_seq,
      bar_seq: first.bar_seq,
      signal_seq: first.signal_seq,
      intent_seq: first.intent_seq,
      parity_trade_id: first.parity_trade_id,
      field_path: first.field_path,
      comparator: first.comparator.comparator,
      numba_value_sha256: first.numba_value_sha256,
      mt5_value_sha256: first.mt5_value_sha256,
      previous_matching_checkpoint: first.previous_matching_checkpoint,
    },
  };
}

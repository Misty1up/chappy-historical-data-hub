import {
  PHASE6_LAYER_PRECEDENCE,
  phase6JsonSha256,
  stablePhase6Json,
  validatePhase6Trace,
  type Phase6JsonValue,
  type Phase6ParityLayer,
  type Phase6TraceEvent,
} from './trace-contract.js';
import {
  findPhase6ComparatorRule,
  validatePhase6ComparatorProfile,
  type Phase6ComparatorProfile,
  type Phase6ComparatorRule,
} from './comparator-profile.js';

export const PHASE6_FIRST_DIVERGENCE_SCHEMA_VERSION = 'HDH_P6_FIRST_DIVERGENCE_V1' as const;

type MaybeValue = Phase6JsonValue | { readonly __missing__: true };
const MISSING = Object.freeze({ __missing__: true }) as { readonly __missing__: true };

export interface Phase6MatchingCheckpoint {
  layer: Phase6ParityLayer;
  event_seq: number;
  canonical_ordinal: number | null;
  timestamp_msc: number | null;
}

export interface Phase6FirstDivergence {
  first_divergence_schema_version: typeof PHASE6_FIRST_DIVERGENCE_SCHEMA_VERSION;
  status: 'DIVERGED';
  parity_run_id: string;
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
  comparator: Phase6ComparatorRule;
  numba_value: MaybeValue;
  mt5_value: MaybeValue;
  numba_value_sha256: string;
  mt5_value_sha256: string;
  previous_matching_checkpoint: Phase6MatchingCheckpoint | null;
  context_refs: { numba_trace_index: number | null; mt5_trace_index: number | null };
}

export interface Phase6TraceComparison {
  status: 'PASS' | 'FAIL';
  parity_run_id: string;
  mismatch_count_total: number;
  mismatch_count_by_layer: Record<Phase6ParityLayer, number>;
  first_divergence: Phase6FirstDivergence | null;
}

interface Candidate {
  run_start: boolean;
  layer: Phase6ParityLayer;
  canonical_ordinal: number | null;
  timestamp_msc: number | null;
  event_seq: number | null;
  bar_seq: number | null;
  signal_seq: number | null;
  intent_seq: number | null;
  parity_trade_id: string | null;
  field_path: string;
  comparator: Phase6ComparatorRule;
  numba_value: MaybeValue;
  mt5_value: MaybeValue;
  numba_trace_index: number | null;
  mt5_trace_index: number | null;
}

function eventKey(event: Phase6TraceEvent): string {
  return `${event.layer}:${event.event_seq}`;
}

function exactEqual(left: MaybeValue, right: MaybeValue): boolean {
  return stablePhase6Json(left) === stablePhase6Json(right);
}

function tolerantEqual(left: MaybeValue, right: MaybeValue, rule: Phase6ComparatorRule): boolean {
  if (rule.comparator === 'EXACT') return exactEqual(left, right);
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  const delta = Math.abs(left - right);
  const absPass = rule.abs_tolerance !== undefined && delta <= rule.abs_tolerance;
  const denominator = Math.max(Math.abs(left), Math.abs(right));
  const relative = denominator === 0 ? 0 : delta / denominator;
  const relPass = rule.rel_tolerance !== undefined && relative <= rule.rel_tolerance;
  if (rule.comparator === 'ABSOLUTE') return absPass;
  if (rule.comparator === 'RELATIVE') return relPass;
  return absPass || relPass;
}

function flattenFields(value: Phase6JsonValue, path: string, output: Map<string, Phase6JsonValue>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    output.set(path, value);
    return;
  }
  if (Array.isArray(value)) {
    output.set(`${path}.__container`, 'ARRAY');
    output.set(`${path}.__length`, value.length);
    value.forEach((item, index) => flattenFields(item, `${path}[${index}]`, output));
    return;
  }
  output.set(`${path}.__container`, 'OBJECT');
  for (const key of Object.keys(value).sort()) flattenFields(value[key]!, `${path}.${key}`, output);
}

function metadataValue(event: Phase6TraceEvent, key: 'canonical_ordinal' | 'timestamp_msc' | 'bar_seq' | 'signal_seq' | 'intent_seq' | 'parity_trade_id'): Phase6JsonValue {
  return event[key];
}

function candidateFromEvent(
  left: Phase6TraceEvent | undefined,
  right: Phase6TraceEvent | undefined,
  fieldPath: string,
  rule: Phase6ComparatorRule,
  leftValue: MaybeValue,
  rightValue: MaybeValue,
  numbaIndex: number | null,
  mt5Index: number | null,
): Candidate {
  const event = left ?? right!;
  return {
    run_start: false,
    layer: event.layer,
    canonical_ordinal: left?.canonical_ordinal ?? right?.canonical_ordinal ?? null,
    timestamp_msc: left?.timestamp_msc ?? right?.timestamp_msc ?? null,
    event_seq: event.event_seq,
    bar_seq: left?.bar_seq ?? right?.bar_seq ?? null,
    signal_seq: left?.signal_seq ?? right?.signal_seq ?? null,
    intent_seq: left?.intent_seq ?? right?.intent_seq ?? null,
    parity_trade_id: left?.parity_trade_id ?? right?.parity_trade_id ?? null,
    field_path: fieldPath,
    comparator: rule,
    numba_value: leftValue,
    mt5_value: rightValue,
    numba_trace_index: numbaIndex,
    mt5_trace_index: mt5Index,
  };
}

function compareCandidateOrder(a: Candidate, b: Candidate): number {
  if (a.run_start !== b.run_start) return a.run_start ? -1 : 1;
  const aOrdinal = a.canonical_ordinal ?? Number.MAX_SAFE_INTEGER;
  const bOrdinal = b.canonical_ordinal ?? Number.MAX_SAFE_INTEGER;
  if (aOrdinal !== bOrdinal) return aOrdinal - bOrdinal;
  const layerDiff = PHASE6_LAYER_PRECEDENCE[a.layer] - PHASE6_LAYER_PRECEDENCE[b.layer];
  if (layerDiff !== 0) return layerDiff;
  const aSeq = a.event_seq ?? -1;
  const bSeq = b.event_seq ?? -1;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.field_path.localeCompare(b.field_path);
}

function checkpointBefore(candidate: Candidate, checkpoints: readonly Phase6MatchingCheckpoint[]): Phase6MatchingCheckpoint | null {
  if (candidate.run_start) return null;
  const targetOrdinal = candidate.canonical_ordinal ?? Number.MAX_SAFE_INTEGER;
  const targetLayer = PHASE6_LAYER_PRECEDENCE[candidate.layer];
  const targetSeq = candidate.event_seq ?? -1;
  let best: Phase6MatchingCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    const ordinal = checkpoint.canonical_ordinal ?? Number.MAX_SAFE_INTEGER;
    const layer = PHASE6_LAYER_PRECEDENCE[checkpoint.layer];
    const before = ordinal < targetOrdinal || (ordinal === targetOrdinal && (layer < targetLayer || (layer === targetLayer && checkpoint.event_seq < targetSeq)));
    if (!before) continue;
    if (best === null) {
      best = checkpoint;
      continue;
    }
    const bestOrdinal = best.canonical_ordinal ?? Number.MAX_SAFE_INTEGER;
    const bestLayer = PHASE6_LAYER_PRECEDENCE[best.layer];
    if (ordinal > bestOrdinal || (ordinal === bestOrdinal && (layer > bestLayer || (layer === bestLayer && checkpoint.event_seq > best.event_seq)))) best = checkpoint;
  }
  return best;
}

function mismatchCounts(candidates: readonly Candidate[]): Record<Phase6ParityLayer, number> {
  const counts: Record<Phase6ParityLayer, number> = { INPUT: 0, INDICATOR_FEATURE: 0, SIGNAL: 0, EXECUTION: 0, RESULT: 0 };
  for (const candidate of candidates) counts[candidate.layer] += 1;
  return counts;
}

export function comparePhase6Traces(
  numbaTrace: readonly Phase6TraceEvent[],
  mt5Trace: readonly Phase6TraceEvent[],
  profile: Phase6ComparatorProfile,
): Phase6TraceComparison {
  validatePhase6ComparatorProfile(profile);
  validatePhase6Trace(numbaTrace, 'NUMBA');
  validatePhase6Trace(mt5Trace, 'MT5');
  const candidates: Candidate[] = [];
  const checkpoints: Phase6MatchingCheckpoint[] = [];
  const numbaRunId = numbaTrace[0]!.parity_run_id;
  const mt5RunId = mt5Trace[0]!.parity_run_id;
  if (numbaRunId !== mt5RunId) {
    candidates.push({
      run_start: true,
      layer: 'INPUT',
      canonical_ordinal: null,
      timestamp_msc: null,
      event_seq: null,
      bar_seq: null,
      signal_seq: null,
      intent_seq: null,
      parity_trade_id: null,
      field_path: 'parity_run_id',
      comparator: { layer: 'INPUT', field_path: 'parity_run_id', comparator: 'EXACT' },
      numba_value: numbaRunId,
      mt5_value: mt5RunId,
      numba_trace_index: 0,
      mt5_trace_index: 0,
    });
  }

  const numba = new Map(numbaTrace.map((event, index) => [eventKey(event), { event, index }]));
  const mt5 = new Map(mt5Trace.map((event, index) => [eventKey(event), { event, index }]));
  const keys = [...new Set([...numba.keys(), ...mt5.keys()])].sort((a, b) => {
    const [aLayer, aSeq] = a.split(':') as [Phase6ParityLayer, string];
    const [bLayer, bSeq] = b.split(':') as [Phase6ParityLayer, string];
    return PHASE6_LAYER_PRECEDENCE[aLayer] - PHASE6_LAYER_PRECEDENCE[bLayer] || Number(aSeq) - Number(bSeq);
  });

  for (const key of keys) {
    const leftEntry = numba.get(key);
    const rightEntry = mt5.get(key);
    const left = leftEntry?.event;
    const right = rightEntry?.event;
    const beforeCount = candidates.length;
    if (left === undefined || right === undefined) {
      const event = left ?? right!;
      const rule: Phase6ComparatorRule = { layer: event.layer, field_path: '$event', comparator: 'EXACT' };
      candidates.push(candidateFromEvent(left, right, '$event', rule, left === undefined ? MISSING : 'PRESENT', right === undefined ? MISSING : 'PRESENT', leftEntry?.index ?? null, rightEntry?.index ?? null));
    } else {
      for (const metadata of ['canonical_ordinal', 'timestamp_msc', 'bar_seq', 'signal_seq', 'intent_seq', 'parity_trade_id'] as const) {
        const leftValue = metadataValue(left, metadata);
        const rightValue = metadataValue(right, metadata);
        if (!exactEqual(leftValue, rightValue)) {
          const rule: Phase6ComparatorRule = { layer: left.layer, field_path: metadata, comparator: 'EXACT' };
          candidates.push(candidateFromEvent(left, right, metadata, rule, leftValue, rightValue, leftEntry!.index, rightEntry!.index));
        }
      }
      const leftFields = new Map<string, Phase6JsonValue>();
      const rightFields = new Map<string, Phase6JsonValue>();
      flattenFields(left.fields, 'fields', leftFields);
      flattenFields(right.fields, 'fields', rightFields);
      const fieldPaths = [...new Set([...leftFields.keys(), ...rightFields.keys()])].sort();
      for (const fieldPath of fieldPaths) {
        const leftValue: MaybeValue = leftFields.has(fieldPath) ? leftFields.get(fieldPath)! : MISSING;
        const rightValue: MaybeValue = rightFields.has(fieldPath) ? rightFields.get(fieldPath)! : MISSING;
        const rule = findPhase6ComparatorRule(profile, left.layer, fieldPath);
        if (!tolerantEqual(leftValue, rightValue, rule)) {
          candidates.push(candidateFromEvent(left, right, fieldPath, rule, leftValue, rightValue, leftEntry!.index, rightEntry!.index));
        }
      }
    }
    if (candidates.length === beforeCount && left !== undefined && right !== undefined) {
      checkpoints.push({ layer: left.layer, event_seq: left.event_seq, canonical_ordinal: left.canonical_ordinal, timestamp_msc: left.timestamp_msc });
    }
  }

  if (candidates.length === 0) {
    return {
      status: 'PASS',
      parity_run_id: numbaRunId,
      mismatch_count_total: 0,
      mismatch_count_by_layer: mismatchCounts(candidates),
      first_divergence: null,
    };
  }
  candidates.sort(compareCandidateOrder);
  const first = candidates[0]!;
  const firstDivergence: Phase6FirstDivergence = {
    first_divergence_schema_version: PHASE6_FIRST_DIVERGENCE_SCHEMA_VERSION,
    status: 'DIVERGED',
    parity_run_id: numbaRunId,
    layer: first.layer,
    classification: first.layer,
    canonical_ordinal: first.canonical_ordinal,
    timestamp_msc: first.timestamp_msc,
    event_seq: first.event_seq,
    bar_seq: first.bar_seq,
    signal_seq: first.signal_seq,
    intent_seq: first.intent_seq,
    parity_trade_id: first.parity_trade_id,
    field_path: first.field_path,
    comparator: { ...first.comparator },
    numba_value: first.numba_value,
    mt5_value: first.mt5_value,
    numba_value_sha256: phase6JsonSha256(first.numba_value),
    mt5_value_sha256: phase6JsonSha256(first.mt5_value),
    previous_matching_checkpoint: checkpointBefore(first, checkpoints),
    context_refs: { numba_trace_index: first.numba_trace_index, mt5_trace_index: first.mt5_trace_index },
  };
  return {
    status: 'FAIL',
    parity_run_id: numbaRunId,
    mismatch_count_total: candidates.length,
    mismatch_count_by_layer: mismatchCounts(candidates),
    first_divergence: firstDivergence,
  };
}

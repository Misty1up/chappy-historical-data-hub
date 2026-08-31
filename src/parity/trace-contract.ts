import { createHash } from 'node:crypto';

export const PHASE6_TRACE_EVENT_SCHEMA_VERSION = 'HDH_P6_TRACE_EVENT_V1' as const;
export const PHASE6_PARITY_LAYERS = ['INPUT', 'INDICATOR_FEATURE', 'SIGNAL', 'EXECUTION', 'RESULT'] as const;
export type Phase6ParityLayer = typeof PHASE6_PARITY_LAYERS[number];
export type Phase6TraceEngine = 'NUMBA' | 'MT5';
export type Phase6JsonValue = null | boolean | number | string | Phase6JsonValue[] | { [key: string]: Phase6JsonValue };

export interface Phase6TraceEvent {
  trace_schema_version: typeof PHASE6_TRACE_EVENT_SCHEMA_VERSION;
  parity_run_id: string;
  engine: Phase6TraceEngine;
  layer: Phase6ParityLayer;
  event_seq: number;
  canonical_ordinal: number | null;
  timestamp_msc: number | null;
  bar_seq: number | null;
  signal_seq: number | null;
  intent_seq: number | null;
  parity_trade_id: string | null;
  fields: { [key: string]: Phase6JsonValue };
}

export class Phase6TraceError extends Error {
  constructor(public readonly code: 'P6_TRACE_INVALID', message: string) {
    super(message);
    this.name = 'Phase6TraceError';
  }
}

export const PHASE6_LAYER_PRECEDENCE: Readonly<Record<Phase6ParityLayer, number>> = Object.freeze({
  INPUT: 0,
  INDICATOR_FEATURE: 1,
  SIGNAL: 2,
  EXECUTION: 3,
  RESULT: 4,
});

function traceError(message: string): never {
  throw new Phase6TraceError('P6_TRACE_INVALID', message);
}

function safeNonNegativeInt(value: number | null, label: string): void {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) traceError(`${label} must be null or a non-negative safe integer`);
}

function validateJson(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) traceError(`${label} must not contain non-finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.length === 0) traceError(`${label} contains an empty object key`);
      validateJson(child, `${label}.${key}`);
    }
    return;
  }
  traceError(`${label} contains a non-JSON value`);
}

export function stablePhase6Json(value: unknown): string {
  function normalize(input: unknown, label: string): Phase6JsonValue {
    validateJson(input, label);
    if (input === null || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') {
      return input as null | string | boolean | number;
    }
    if (Array.isArray(input)) return input.map((item, index) => normalize(item, `${label}[${index}]`));
    const output: Record<string, Phase6JsonValue> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      output[key] = normalize((input as Record<string, unknown>)[key], `${label}.${key}`);
    }
    return output;
  }
  return JSON.stringify(normalize(value, 'value'));
}

export function phase6JsonSha256(value: unknown): string {
  return createHash('sha256').update(stablePhase6Json(value), 'utf8').digest('hex');
}

export function validatePhase6Trace(events: readonly Phase6TraceEvent[], expectedEngine?: Phase6TraceEngine): void {
  if (events.length === 0) traceError('trace must contain at least one event');
  let runId: string | null = null;
  const lastSeq = new Map<Phase6ParityLayer, number>();
  const seenKeys = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.trace_schema_version !== PHASE6_TRACE_EVENT_SCHEMA_VERSION) traceError(`events[${index}].trace_schema_version is unsupported`);
    if (!/^HDH_P6_RUN_V1_[0-9a-f]{64}$/.test(event.parity_run_id)) traceError(`events[${index}].parity_run_id is invalid`);
    if (runId === null) runId = event.parity_run_id;
    else if (event.parity_run_id !== runId) traceError('one trace must not mix parity_run_id values');
    if (event.engine !== 'NUMBA' && event.engine !== 'MT5') traceError(`events[${index}].engine is invalid`);
    if (expectedEngine !== undefined && event.engine !== expectedEngine) traceError(`trace contains ${event.engine} event where ${expectedEngine} was required`);
    if (!(event.layer in PHASE6_LAYER_PRECEDENCE)) traceError(`events[${index}].layer is invalid`);
    safeNonNegativeInt(event.event_seq, `events[${index}].event_seq`);
    safeNonNegativeInt(event.canonical_ordinal, `events[${index}].canonical_ordinal`);
    safeNonNegativeInt(event.timestamp_msc, `events[${index}].timestamp_msc`);
    safeNonNegativeInt(event.bar_seq, `events[${index}].bar_seq`);
    safeNonNegativeInt(event.signal_seq, `events[${index}].signal_seq`);
    safeNonNegativeInt(event.intent_seq, `events[${index}].intent_seq`);
    if (event.parity_trade_id !== null && (typeof event.parity_trade_id !== 'string' || event.parity_trade_id.length === 0)) {
      traceError(`events[${index}].parity_trade_id must be null or a non-empty string`);
    }
    if (typeof event.fields !== 'object' || event.fields === null || Array.isArray(event.fields)) traceError(`events[${index}].fields must be an object`);
    validateJson(event.fields, `events[${index}].fields`);
    const key = `${event.layer}:${event.event_seq}`;
    if (seenKeys.has(key)) traceError(`duplicate trace event identity ${key}`);
    seenKeys.add(key);
    const previous = lastSeq.get(event.layer);
    if (previous !== undefined && event.event_seq <= previous) traceError(`${event.layer} event_seq must increase in emitted trace order`);
    lastSeq.set(event.layer, event.event_seq);
  }
}

export function phase6TraceRootSha256(events: readonly Phase6TraceEvent[]): string {
  validatePhase6Trace(events);
  return phase6JsonSha256(events);
}

export function phase6LayerEventCounts(events: readonly Phase6TraceEvent[]): Record<Phase6ParityLayer, number> {
  const counts: Record<Phase6ParityLayer, number> = { INPUT: 0, INDICATOR_FEATURE: 0, SIGNAL: 0, EXECUTION: 0, RESULT: 0 };
  for (const event of events) counts[event.layer] += 1;
  return counts;
}

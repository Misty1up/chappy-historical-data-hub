import {
  phase6LayerEventCounts,
  phase6TraceRootSha256,
  validatePhase6Trace,
  type Phase6ParityLayer,
  type Phase6TraceEvent,
} from './trace-contract.js';

export const P6_MT5_REFERENCE_ADAPTER_VERSION = 'P6_MT5_REFERENCE_ADAPTER_V1' as const;
export const P6_MT5_REFERENCE_TRACE_FORMAT = 'JSONL_EVENT_PER_LINE_V1' as const;

export class Phase6Mt5TraceParseError extends Error {
  constructor(public readonly code: 'P6_MT5_TRACE_PARSE_INVALID', message: string) {
    super(message);
    this.name = 'Phase6Mt5TraceParseError';
  }
}

export interface Phase6Mt5TraceSummary {
  adapter_version: typeof P6_MT5_REFERENCE_ADAPTER_VERSION;
  trace_format: typeof P6_MT5_REFERENCE_TRACE_FORMAT;
  parity_run_id: string;
  trace_event_count: number;
  layer_counts: Record<Phase6ParityLayer, number>;
  trace_root_sha256: string;
}

function parseError(message: string): never {
  throw new Phase6Mt5TraceParseError('P6_MT5_TRACE_PARSE_INVALID', message);
}

export function parsePhase6Mt5TraceJsonl(text: string): Phase6TraceEvent[] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length === 0) parseError('MT5 trace JSONL must contain at least one event');

  const events: Phase6TraceEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      events.push(JSON.parse(lines[index]!) as Phase6TraceEvent);
    } catch (error) {
      parseError(`MT5 trace line ${index + 1} is not valid JSON: ${String(error)}`);
    }
  }
  validatePhase6Trace(events, 'MT5');
  return events;
}

export function summarizePhase6Mt5Trace(events: readonly Phase6TraceEvent[]): Phase6Mt5TraceSummary {
  validatePhase6Trace(events, 'MT5');
  return {
    adapter_version: P6_MT5_REFERENCE_ADAPTER_VERSION,
    trace_format: P6_MT5_REFERENCE_TRACE_FORMAT,
    parity_run_id: events[0]!.parity_run_id,
    trace_event_count: events.length,
    layer_counts: phase6LayerEventCounts(events),
    trace_root_sha256: phase6TraceRootSha256(events),
  };
}

export function ingestPhase6Mt5TraceJsonl(text: string): Phase6Mt5TraceSummary {
  return summarizePhase6Mt5Trace(parsePhase6Mt5TraceJsonl(text));
}

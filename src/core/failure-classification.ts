export type FailureClass =
  | 'FETCH_FAILED'
  | 'UPSTREAM_EMPTY'
  | 'INVALID_PAYLOAD'
  | 'TIMESTAMP_OUT_OF_RANGE'
  | 'NON_MONOTONIC_INPUT'
  | 'INVALID_BID'
  | 'INVALID_ASK'
  | 'NEGATIVE_SPREAD'
  | 'CACHE_WRITE_FAILED'
  | 'HASH_MISMATCH'
  | 'UNEXPLAINED_ZERO_TICK'
  | 'EMPTY_UNCLASSIFIED'
  | 'UNKNOWN';

export function classifyError(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('hash')) return 'HASH_MISMATCH';
  if (message.includes('cache') && (message.includes('write') || message.includes('save'))) return 'CACHE_WRITE_FAILED';
  if (message.includes('payload') || message.includes('unsafe') || message.includes('timestamp') || message.includes('non-finite')) {
    return 'INVALID_PAYLOAD';
  }
  if (message.includes('empty')) return 'UPSTREAM_EMPTY';
  if (message.includes('fetch') || message.includes('network') || message.includes('timeout') || message.includes('http')) {
    return 'FETCH_FAILED';
  }
  return 'UNKNOWN';
}

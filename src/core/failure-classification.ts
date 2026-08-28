export type FailureClass =
  | 'NETWORK_OR_UPSTREAM'
  | 'INVALID_PAYLOAD'
  | 'INTEGRITY_FAILURE'
  | 'HASH_MISMATCH'
  | 'EMPTY_UNCLASSIFIED'
  | 'UNKNOWN';

export function classifyError(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('hash')) return 'HASH_MISMATCH';
  if (message.includes('payload') || message.includes('timestamp') || message.includes('non-finite')) return 'INVALID_PAYLOAD';
  if (message.includes('fetch') || message.includes('network') || message.includes('timeout') || message.includes('http')) {
    return 'NETWORK_OR_UPSTREAM';
  }
  return 'UNKNOWN';
}

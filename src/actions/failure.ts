export function classifyPhase4ExecutionFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (detail.includes('exact UTC midnight') || detail.includes('range contains no UTC days')) return 'INVALID_UTC_RANGE';
  if (normalized.includes('precision metadata request failed') || normalized.includes('upstream precision')) return 'PRECISION_NOT_VERIFIED';
  return 'INTERNAL_ERROR';
}

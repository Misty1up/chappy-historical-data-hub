export type Phase4ExecutionStage = 'ACQUISITION' | 'PRECISION' | 'CANONICAL' | 'MT5_DERIVATIVE' | 'PACKET' | 'UNKNOWN';

export function phase4ExecutionStageForCommand(args: readonly string[]): Phase4ExecutionStage {
  switch (args[0]) {
    case 'dist/src/cli.js':
      return args[1] === 'acquire' ? 'ACQUISITION' : 'UNKNOWN';
    case 'dist/src/precision-cli.js':
      return 'PRECISION';
    case 'dist/src/parquet-cli.js':
      return 'CANONICAL';
    case 'dist/src/mt5-cli.js':
      return 'MT5_DERIVATIVE';
    case 'dist/src/packet-cli.js':
      return 'PACKET';
    default:
      return 'UNKNOWN';
  }
}

export class Phase4CommandExecutionError extends Error {
  readonly stage: Phase4ExecutionStage;
  readonly command: readonly string[];

  constructor(args: readonly string[], cause: unknown) {
    const stage = phase4ExecutionStageForCommand(args);
    super(
      `Phase 4 ${stage} command failed: ${args.join(' ')}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = 'Phase4CommandExecutionError';
    this.stage = stage;
    this.command = [...args];
  }
}

export function classifyPhase4ExecutionFailure(error: unknown): string {
  if (error instanceof Phase4CommandExecutionError && error.stage === 'PRECISION') {
    return 'PRECISION_NOT_VERIFIED';
  }

  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (detail.includes('exact UTC midnight') || detail.includes('range contains no UTC days')) return 'INVALID_UTC_RANGE';
  if (normalized.includes('precision metadata request failed') || normalized.includes('upstream precision')) return 'PRECISION_NOT_VERIFIED';
  return 'INTERNAL_ERROR';
}

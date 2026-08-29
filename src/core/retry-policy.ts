export const PROJECT_RETRY_BASE_MS = 1000;
export const PROJECT_RETRY_JITTER_MS = 250;
export const PROJECT_DEFAULT_MAX_ATTEMPTS = 4;

export function retryDelayMs(attempt: number, randomValue = Math.random()): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new Error('randomValue must be between 0 and 1');
  }
  const exponential = PROJECT_RETRY_BASE_MS * (2 ** (attempt - 1));
  const jitter = Math.floor(PROJECT_RETRY_JITTER_MS * randomValue);
  return exponential + jitter;
}

export async function waitBeforeRetry(attempt: number): Promise<number> {
  const delayMs = retryDelayMs(attempt);
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return delayMs;
}

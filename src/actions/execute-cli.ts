import { readFile } from 'node:fs/promises';
import { buildPhase4ExecutionPlan, executePhase4Plan } from './execute.js';
import type { WebJobRequest } from '../web/contract.js';

async function main(): Promise<void> {
  const requestPath = process.env.HDH_VALIDATED_REQUEST_PATH ?? '.hdh-phase4/validated-request.json';
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as WebJobRequest;
  if (request.mode === 'MT5_PARITY_MASTER') {
    console.error('P4.3 does not enable MT5_PARITY_MASTER execution; P4.4 is required');
    process.exitCode = 3;
    return;
  }

  const plan = buildPhase4ExecutionPlan(request);
  console.log(`Phase 4 P4.3 execution start: ${request.symbol} ${request.mode} days=${plan.utcDays.length}`);
  await executePhase4Plan(plan);
  console.log(`Phase 4 P4.3 execution complete: ${plan.paths.root}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

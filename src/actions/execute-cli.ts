import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../core/atomic-write.js';
import type { DatasetPacketManifest } from '../packet/types.js';
import type { WebJobRequest } from '../web/contract.js';
import { buildPhase4ExecutionPlan, executePhase4Plan, phase4ExecutionRootForRequest } from './execute.js';
import { buildFailureActionResult, buildPassActionResult, type Phase4QuickManifest, type Phase4ResultContext } from './result.js';

function gitCommit(): string {
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha && /^[0-9a-f]{40}$/.test(envSha)) return envSha;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

function context(startedAtUtc: string): Phase4ResultContext {
  return {
    workflow_run_id: process.env.GITHUB_RUN_ID ?? 'LOCAL',
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    repository_commit: gitCommit(),
    started_at_utc: startedAtUtc,
    completed_at_utc: new Date().toISOString(),
  };
}

export function classifyFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes('exact UTC midnight') || detail.includes('range contains no UTC days')) return 'INVALID_UTC_RANGE';
  if (detail.includes('Precision metadata request failed') || detail.includes('upstream precision')) return 'PRECISION_NOT_VERIFIED';
  return 'INTERNAL_ERROR';
}

async function main(): Promise<void> {
  const requestPath = process.env.HDH_VALIDATED_REQUEST_PATH ?? '.hdh-phase4/validated-request.json';
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as WebJobRequest;
  const startedAtUtc = new Date().toISOString();
  const root = phase4ExecutionRootForRequest(request);
  const resultPath = resolve(root, 'action_result.json');

  try {
    const plan = buildPhase4ExecutionPlan(request);
    console.log(`Phase 4 P4.5 execution start: ${request.symbol} ${request.mode} days=${plan.utcDays.length}`);
    await executePhase4Plan(plan);

    const manifestPath = request.mode === 'QUICK_DOWNLOAD'
      ? resolve(plan.paths.sourceRun, 'manifest.json')
      : resolve(plan.paths.packet, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Phase4QuickManifest | DatasetPacketManifest;
    const result = buildPassActionResult(request, manifest, context(startedAtUtc));
    await atomicWriteFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    JSON.parse(await readFile(resultPath, 'utf8'));

    console.log(`Phase 4 P4.5 execution complete: ${plan.paths.root}`);
    console.log(`Action result: ${resultPath}`);
  } catch (error: unknown) {
    await mkdir(root, { recursive: true });
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    const result = buildFailureActionResult(request, context(startedAtUtc), classifyFailure(error), detail);
    await atomicWriteFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.error(detail);
    console.error(`Failure action result: ${resultPath}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../core/atomic-write.js';
import type { DatasetPacketManifest } from '../packet/types.js';
import type { WebJobRequest } from '../web/contract.js';
import { buildPhase4ExecutionPlan, executePhase4Plan } from './execute.js';
import { buildPassActionResult, type Phase4QuickManifest } from './result.js';

function gitCommit(): string {
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha && /^[0-9a-f]{40}$/.test(envSha)) return envSha;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

async function main(): Promise<void> {
  const requestPath = process.env.HDH_VALIDATED_REQUEST_PATH ?? '.hdh-phase4/validated-request.json';
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as WebJobRequest;
  const plan = buildPhase4ExecutionPlan(request);
  const startedAtUtc = new Date().toISOString();

  console.log(`Phase 4 P4.4 execution start: ${request.symbol} ${request.mode} days=${plan.utcDays.length}`);
  await executePhase4Plan(plan);

  const manifestPath = request.mode === 'QUICK_DOWNLOAD'
    ? resolve(plan.paths.sourceRun, 'manifest.json')
    : resolve(plan.paths.packet, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Phase4QuickManifest | DatasetPacketManifest;
  const completedAtUtc = new Date().toISOString();
  const result = buildPassActionResult(request, manifest, {
    workflow_run_id: process.env.GITHUB_RUN_ID ?? 'LOCAL',
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    repository_commit: gitCommit(),
    started_at_utc: startedAtUtc,
    completed_at_utc: completedAtUtc,
  });
  const resultPath = resolve(plan.paths.root, 'action_result.json');
  await atomicWriteFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  JSON.parse(await readFile(resultPath, 'utf8'));

  console.log(`Phase 4 P4.4 execution complete: ${plan.paths.root}`);
  console.log(`Action result: ${resultPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

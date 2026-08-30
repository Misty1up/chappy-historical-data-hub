import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../core/atomic-write.js';
import type { WebJobRequest } from '../web/contract.js';
import {
  artifactNameForRequest,
  assessArtifactSize,
  attachTemporaryArtifactReference,
  clearSuccessMetadataForTerminalResult,
  measureArtifactInventory,
  PHASE4_ARTIFACT_CAP_BYTES,
} from './artifact.js';
import { buildPhase4ExecutionPlan, phase4ExecutionRootForRequest } from './execute.js';
import { buildFailureActionResult, type Phase4ActionResult } from './result.js';

async function writeOutput(key: string, value: string | number): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(output, `${key}=${String(value)}\n`, 'utf8');
}

function runReference(): string {
  const runId = process.env.GITHUB_RUN_ID ?? 'LOCAL';
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY;
  return repo ? `${server}/${repo}/actions/runs/${runId}` : `local-run://${runId}`;
}

function fallbackFailure(request: WebJobRequest, detail: string): Phase4ActionResult {
  const now = new Date().toISOString();
  return buildFailureActionResult(request, {
    workflow_run_id: process.env.GITHUB_RUN_ID ?? 'LOCAL',
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    repository_commit: process.env.GITHUB_SHA ?? 'UNKNOWN',
    started_at_utc: now,
    completed_at_utc: now,
  }, 'INTERNAL_ERROR', detail);
}

async function writeResult(path: string, result: Phase4ActionResult): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(result, null, 2)}\n`);
}

async function writeDiagnostic(root: string, result: Phase4ActionResult): Promise<string> {
  const dir = resolve(root, 'diagnostic');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, 'action_result.json');
  await writeResult(path, result);
  return path;
}

async function loadOrCreateResult(request: WebJobRequest, root: string): Promise<{ result: Phase4ActionResult; resultPath: string }> {
  const resultPath = resolve(root, 'action_result.json');
  try {
    return { result: JSON.parse(await readFile(resultPath, 'utf8')) as Phase4ActionResult, resultPath };
  } catch (error: unknown) {
    await mkdir(root, { recursive: true });
    const detail = `Execution did not leave a readable action_result.json: ${error instanceof Error ? error.message : String(error)}`;
    const result = fallbackFailure(request, detail);
    await writeResult(resultPath, result);
    return { result, resultPath };
  }
}

async function emitDiagnosticOutputs(request: WebJobRequest, result: Phase4ActionResult, diagnosticPath: string): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? 'LOCAL';
  await writeOutput('transport_status', result.status);
  await writeOutput('diagnostic_name', `${artifactNameForRequest(request, runId)}-diagnostic`);
  await writeOutput('diagnostic_path', diagnosticPath);
  await writeOutput('artifact_name', '');
  await writeOutput('primary_path', '');
  await writeOutput('result_path', '');
}

async function prepare(): Promise<void> {
  const requestPath = process.env.HDH_VALIDATED_REQUEST_PATH ?? '.hdh-phase4/validated-request.json';
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as WebJobRequest;
  const root = phase4ExecutionRootForRequest(request);
  const loaded = await loadOrCreateResult(request, root);
  let result = loaded.result;

  if (result.status !== 'PASS') {
    const diagnosticPath = await writeDiagnostic(root, result);
    await emitDiagnosticOutputs(request, result, diagnosticPath);
    return;
  }

  const plan = buildPhase4ExecutionPlan(request);
  const runId = process.env.GITHUB_RUN_ID ?? 'LOCAL';
  const artifactName = artifactNameForRequest(request, runId);
  const primaryPath = request.mode === 'QUICK_DOWNLOAD' ? resolve(plan.paths.sourceRun) : resolve(plan.paths.packet);
  result = attachTemporaryArtifactReference(result, artifactName, runReference());
  await writeResult(loaded.resultPath, result);

  const totalBytes = await measureArtifactInventory([primaryPath, loaded.resultPath]);
  const decision = assessArtifactSize(totalBytes, PHASE4_ARTIFACT_CAP_BYTES);
  await writeOutput('total_bytes', totalBytes);

  if (decision.status === 'HOLD') {
    result = clearSuccessMetadataForTerminalResult(
      result,
      'HOLD',
      'ARTIFACT_TOO_LARGE',
      `Artifact inventory is ${totalBytes} bytes and exceeds the ${PHASE4_ARTIFACT_CAP_BYTES}-byte Phase 4 safety cap. Download/generate through the local fallback path; no partial success Artifact was uploaded.`,
      true,
    );
    await writeResult(loaded.resultPath, result);
    const diagnosticPath = await writeDiagnostic(root, result);
    await emitDiagnosticOutputs(request, result, diagnosticPath);
    return;
  }

  await writeOutput('transport_status', 'PASS');
  await writeOutput('artifact_name', artifactName);
  await writeOutput('primary_path', primaryPath);
  await writeOutput('result_path', loaded.resultPath);
  await writeOutput('diagnostic_name', '');
  await writeOutput('diagnostic_path', '');
}

async function uploadFailed(): Promise<void> {
  const requestPath = process.env.HDH_VALIDATED_REQUEST_PATH ?? '.hdh-phase4/validated-request.json';
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as WebJobRequest;
  const root = phase4ExecutionRootForRequest(request);
  const loaded = await loadOrCreateResult(request, root);
  const result = clearSuccessMetadataForTerminalResult(
    loaded.result,
    'FAIL',
    'ARTIFACT_UPLOAD_FAIL',
    'GitHub Actions Artifact upload failed. Dataset/Packet authority was not changed; use local fallback or rerun after the transport service recovers.',
    true,
  );
  await writeResult(loaded.resultPath, result);
  const diagnosticPath = await writeDiagnostic(root, result);
  await emitDiagnosticOutputs(request, result, diagnosticPath);
}

const command = process.argv[2] ?? 'prepare';
if (command === 'prepare') {
  await prepare();
} else if (command === 'upload-failed') {
  await uploadFailed();
} else {
  throw new Error(`Unknown transport command: ${command}`);
}

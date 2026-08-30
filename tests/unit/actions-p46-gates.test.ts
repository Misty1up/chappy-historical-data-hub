import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessArtifactSize, clearSuccessMetadataForTerminalResult, PHASE4_ARTIFACT_CAP_BYTES } from '../../src/actions/artifact.js';
import { buildPhase4ExecutionPlan } from '../../src/actions/execute.js';
import { parseWorkflowRequestJson } from '../../src/actions/request.js';
import { buildPassActionResult, type Phase4ActionResult } from '../../src/actions/result.js';
import type { DatasetPacketManifest } from '../../src/packet/types.js';
import type { WebJobRequest } from '../../src/web/contract.js';

const workflow = readFileSync('.github/workflows/data-job.yml', 'utf8');
const executionSource = readFileSync('src/actions/execute.ts', 'utf8');

function request(mode: WebJobRequest['mode'] = 'RESEARCH_MASTER'): WebJobRequest {
  return {
    request_schema_version: '0.1',
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-07T00:00:00.000Z',
    mode,
    requested_output: mode === 'QUICK_DOWNLOAD' ? 'QUICK_EXPORT' : 'DATASET_PACKET',
    accepted_contract_version: 'HDH_PHASE2_ACCEPTED_V1',
  };
}

function packet(): DatasetPacketManifest {
  return {
    manifest_schema_version: '0.1.0',
    dataset_id: `HDH_DATASET_V1_${'a'.repeat(64)}`,
    canonical_schema_version: '0.1',
    generator_git_commit: 'b'.repeat(40),
    source_run_id: 'HDH_EURUSD_20260105_20260107',
    source_hash_root: '1'.repeat(64),
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-07T00:00:00.000Z',
    tick_count_total: 123,
    canonical_file_count: 2,
    price_digits: 5,
    price_scale: 100000,
    precision_status: 'VERIFIED',
    precision_evidence_sha256: '2'.repeat(64),
    canonical_logical_hash_root: '3'.repeat(64),
    parquet_file_hash_root: '4'.repeat(64),
    mt5_derivative_hash_root: '5'.repeat(64),
    integrity_status: 'PASS',
    canonical_promotion_allowed: true,
    generated_at_utc: '2026-08-30T00:00:00.000Z',
  };
}

const context = {
  workflow_run_id: '123',
  workflow_run_attempt: '1',
  repository_commit: 'c'.repeat(40),
  started_at_utc: '2026-08-30T01:00:00.000Z',
  completed_at_utc: '2026-08-30T01:01:00.000Z',
};

test('P4.6 deterministic orchestration produces the same UTC-day plan and command sequence for the same normalized request', () => {
  const first = buildPhase4ExecutionPlan(request());
  const second = buildPhase4ExecutionPlan(request());
  assert.deepEqual(second, first);
  assert.deepEqual(first.utcDays, ['2026-01-05', '2026-01-06']);
});

test('P4.6 orchestration delegates retry/resume semantics to accepted CLIs without force, rebaseline, sort, dedupe or gap-fill bypasses', () => {
  const plan = buildPhase4ExecutionPlan(request());
  const flattened = plan.commands.flat().join(' ');
  assert.doesNotMatch(flattened, /--force\b/);
  assert.doesNotMatch(flattened, /rebaseline|dedupe|gap[-_ ]?fill|sort-source/i);
  assert.match(executionSource, /dist\/src\/cli\.js/);
  assert.match(executionSource, /dist\/src\/parquet-cli\.js/);
  assert.match(executionSource, /dist\/src\/packet-cli\.js/);
  assert.doesNotMatch(executionSource, /retry\s*=|setTimeout\(|sleep\(/);
});

test('P4.6 workflow request authority rejects injected accepted-baseline or result identity fields', async () => {
  const base = request();
  for (const [field, value] of [
    ['dataset_id', 'HDH_DATASET_V1_fake'],
    ['source_hash_root', '1'.repeat(64)],
    ['canonical_logical_hash_root', '2'.repeat(64)],
    ['price_scale', 100000],
    ['accepted_source_sha256', '3'.repeat(64)],
  ] as const) {
    const injected = JSON.stringify({ ...base, [field]: value });
    await assert.rejects(() => parseWorkflowRequestJson(injected), /Unexpected request field/);
  }
});

test('P4.6 packet authority mismatch cannot produce PASS result metadata', () => {
  const req = request();
  const manifest = packet();
  assert.throws(
    () => buildPassActionResult(req, { ...manifest, requested_to_utc: '2026-01-08T00:00:00.000Z' }, context),
    /requested_to_utc mismatch/,
  );
  assert.throws(
    () => buildPassActionResult(req, { ...manifest, canonical_promotion_allowed: false }, context),
    /not Canonical-promotion eligible/,
  );
  assert.throws(
    () => buildPassActionResult(req, { ...manifest, integrity_status: 'FAIL' }, context),
    /integrity is not PASS/,
  );
});

test('P4.6 resource boundary is exact: 200 MiB may continue, one byte more is HOLD/local fallback', () => {
  assert.deepEqual(assessArtifactSize(PHASE4_ARTIFACT_CAP_BYTES), {
    status: 'PASS',
    total_bytes: PHASE4_ARTIFACT_CAP_BYTES,
    failure_code: null,
    local_fallback_required: false,
  });
  assert.deepEqual(assessArtifactSize(PHASE4_ARTIFACT_CAP_BYTES + 1), {
    status: 'HOLD',
    total_bytes: PHASE4_ARTIFACT_CAP_BYTES + 1,
    failure_code: 'ARTIFACT_TOO_LARGE',
    local_fallback_required: true,
  });
});

test('P4.6 every FAIL/HOLD terminalization clears success identity and artifact references', () => {
  const pass = buildPassActionResult(request(), packet(), context);
  const withReference: Phase4ActionResult = {
    ...pass,
    packet_artifact_name: 'hdh-pass',
    packet_artifact_reference: 'https://github.com/example/actions/runs/123',
  };
  for (const status of ['FAIL', 'HOLD'] as const) {
    const terminal = clearSuccessMetadataForTerminalResult(withReference, status, 'INTERNAL_ERROR', 'gate failed', status === 'HOLD');
    assert.equal(terminal.status, status);
    assert.equal(terminal.dataset_id, null);
    assert.equal(terminal.tick_count_total, null);
    assert.equal(terminal.source_hash_root, null);
    assert.equal(terminal.canonical_logical_hash_root, null);
    assert.equal(terminal.canonical_promotion_allowed, false);
    assert.equal(terminal.packet_artifact_name, null);
    assert.equal(terminal.packet_artifact_reference, null);
  }
});

test('P4.6 execution workflow remains read-only, secret-free, bounded and separated from CI/release/package mutation', () => {
  assert.match(workflow, /^permissions:\s*\n\s*contents: read/m);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /retention-days: 1/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /contents:\s*write|packages:\s*write|actions:\s*write|issues:\s*write|pull-requests:\s*write|deployments:\s*write/i);
  assert.doesNotMatch(workflow, /gh\s+(release|pr|issue)|git\s+(push|commit|tag)|npm\s+publish/i);
  assert.doesNotMatch(workflow, /self-hosted|larger-runner/i);
});

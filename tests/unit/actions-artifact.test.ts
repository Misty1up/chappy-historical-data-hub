import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessArtifactSize,
  attachTemporaryArtifactReference,
  clearSuccessMetadataForTerminalResult,
  measureArtifactInventory,
  PHASE4_ARTIFACT_CAP_BYTES,
  PHASE4_ARTIFACT_RETENTION_DAYS,
} from '../../src/actions/artifact.js';
import type { Phase4ActionResult } from '../../src/actions/result.js';

function passResult(): Phase4ActionResult {
  return {
    action_result_schema_version: '0.1.0',
    request: {
      request_schema_version: '0.1',
      symbol: 'EURUSD',
      requested_from_utc: '2026-01-05T00:00:00.000Z',
      requested_to_utc: '2026-01-06T00:00:00.000Z',
      mode: 'RESEARCH_MASTER',
      requested_output: 'DATASET_PACKET',
      accepted_contract_version: 'HDH_PHASE2_ACCEPTED_V1',
    },
    workflow_run_id: '123',
    workflow_run_attempt: '1',
    repository_commit: 'a'.repeat(40),
    status: 'PASS',
    started_at_utc: '2026-01-06T00:00:00.000Z',
    completed_at_utc: '2026-01-06T00:01:00.000Z',
    dataset_id: `HDH_DATASET_V1_${'b'.repeat(64)}`,
    symbol: 'EURUSD',
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    mode: 'RESEARCH_MASTER',
    tick_count_total: 10,
    source_hash_root: 'c'.repeat(64),
    canonical_logical_hash_root: 'd'.repeat(64),
    integrity_status: 'PASS',
    canonical_promotion_allowed: true,
    packet_artifact_name: null,
    packet_artifact_reference: null,
    failure_code: null,
    failure_detail: null,
    local_fallback_required: false,
    is_fixture: false,
  };
}

test('P4.5 Artifact inventory measures deliverable bytes before upload without following symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hdh-p45-'));
  try {
    const packet = join(root, 'packet');
    await mkdir(packet);
    await writeFile(join(packet, 'manifest.json'), '12345');
    const result = join(root, 'action_result.json');
    await writeFile(result, '1234567');
    assert.equal(await measureArtifactInventory([packet, result]), 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P4.5 200 MiB safety envelope is inclusive and larger inventory becomes HOLD', async () => {
  assert.equal(PHASE4_ARTIFACT_RETENTION_DAYS, 1);
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

  const root = await mkdtemp(join(tmpdir(), 'hdh-p45-large-'));
  try {
    const sparse = join(root, 'large.bin');
    await writeFile(sparse, '');
    await truncate(sparse, PHASE4_ARTIFACT_CAP_BYTES + 1);
    assert.equal(await measureArtifactInventory([sparse]), PHASE4_ARTIFACT_CAP_BYTES + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P4.5 FAIL/HOLD result clearing removes success Dataset Packet identity and Artifact references', () => {
  const attached = attachTemporaryArtifactReference(passResult(), 'artifact-name', 'https://github.com/example/actions/runs/123');
  assert.equal(attached.packet_artifact_name, 'artifact-name');

  const held = clearSuccessMetadataForTerminalResult(attached, 'HOLD', 'ARTIFACT_TOO_LARGE', 'too large', true);
  assert.equal(held.status, 'HOLD');
  assert.equal(held.dataset_id, null);
  assert.equal(held.source_hash_root, null);
  assert.equal(held.canonical_logical_hash_root, null);
  assert.equal(held.tick_count_total, null);
  assert.equal(held.canonical_promotion_allowed, false);
  assert.equal(held.packet_artifact_name, null);
  assert.equal(held.packet_artifact_reference, null);
  assert.equal(held.failure_code, 'ARTIFACT_TOO_LARGE');
  assert.equal(held.local_fallback_required, true);
});

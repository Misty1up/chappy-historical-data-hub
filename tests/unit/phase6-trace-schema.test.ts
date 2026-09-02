import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPhase6ComparatorProfile, validatePhase6ComparatorProfile, Phase6ComparatorProfileError } from '../../src/parity/comparator-profile.js';

const SCHEMAS = [
  'phase6_trace_event.schema.json',
  'phase6_comparator_profile.schema.json',
  'phase6_first_divergence.schema.json',
  'phase6_parity_summary.schema.json',
] as const;

test('P6.2 public schemas are strict, synthetic-safe and contain no accepted real dataset literal', async () => {
  const texts = await Promise.all(SCHEMAS.map(name => readFile(resolve('schemas', name), 'utf8')));
  const realDataset = 'HDH_DATASET_V1_704e2be6a75216952161f8e152518057900f29e20a670e2f5898cdbf34dda926';
  for (const [index, text] of texts.entries()) {
    const schema = JSON.parse(text) as Record<string, unknown>;
    assert.equal(schema.additionalProperties, false, `${SCHEMAS[index]} must reject undeclared top-level fields`);
    assert.equal(text.includes(realDataset), false);
    assert.equal(text.includes('global_epsilon'), false);
  }
});

test('P6.2 trace/summary schemas require deterministic identity and first-divergence surfaces', async () => {
  const trace = JSON.parse(await readFile(resolve('schemas/phase6_trace_event.schema.json'), 'utf8')) as { required: string[] };
  for (const field of ['parity_run_id','engine','layer','event_seq','canonical_ordinal','timestamp_msc','bar_seq','signal_seq','intent_seq','parity_trade_id','fields']) assert.ok(trace.required.includes(field));
  const summary = JSON.parse(await readFile(resolve('schemas/phase6_parity_summary.schema.json'), 'utf8')) as { required: string[] };
  for (const field of ['parity_run_id','comparator_profile_sha256','numba_trace_root_sha256','mt5_trace_root_sha256','mismatch_count_total','layer_results','first_divergence']) assert.ok(summary.required.includes(field));
});

test('P6.2 comparator profile rejects duplicate rules and hash tampering', () => {
  assert.throws(() => createPhase6ComparatorProfile('DUP', [
    { layer:'RESULT', field_path:'fields.pnl', comparator:'EXACT' },
    { layer:'RESULT', field_path:'fields.pnl', comparator:'EXACT' },
  ]), (cause: unknown) => cause instanceof Phase6ComparatorProfileError);
  const profile = createPhase6ComparatorProfile('HASHED', [{ layer:'RESULT', field_path:'fields.pnl', comparator:'EXACT' }]);
  const tampered = { ...profile, comparator_profile_sha256: 'f'.repeat(64) };
  assert.throws(() => validatePhase6ComparatorProfile(tampered), (cause: unknown) => cause instanceof Phase6ComparatorProfileError);
});

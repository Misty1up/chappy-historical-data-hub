import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebJobView } from '../../src/web/status-result.js';
import { assertWebJobView } from '../../src/web/status-result.js';

const root = process.cwd();
const html = readFileSync(resolve(root, 'web', 'index.html'), 'utf8');
const app = readFileSync(resolve(root, 'web', 'app.js'), 'utf8');
const css = readFileSync(resolve(root, 'web', 'styles.css'), 'utf8');

test('Web MVP static shell exposes accessibility and mobile hardening hooks', () => {
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /id="main-content"/);
  assert.match(html, /role="alert" aria-live="assertive"/);
  assert.match(html, /id="validation-state"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="job-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /aria-describedby="symbol-help"/);
  assert.match(html, /aria-describedby="mode-help"/);
  assert.match(css, /min-height: 48px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /forced-colors: active/);
});

test('Web rendering avoids injecting fixture or validation values through innerHTML', () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(app, /textContent/);
  assert.match(app, /document\.createElement/);
});

test('Phase 3 result authority guard rejects any fixture that can promote Canonical state', () => {
  const invalid: WebJobView = {
    status: 'PASS',
    detail: 'invalid fixture',
    result: {
      dataset_id: 'FIXTURE_ONLY_EURUSD_2026-01-05',
      symbol: 'EURUSD',
      requested_from_utc: '2026-01-05T00:00:00.000Z',
      requested_to_utc: '2026-01-06T00:00:00.000Z',
      tick_count_total: 1,
      source_hash_root: '1'.repeat(64),
      canonical_logical_hash_root: '2'.repeat(64),
      integrity_status: 'PASS',
      canonical_promotion_allowed: true,
      packet_artifact_reference: 'fixture://dataset-packet/EURUSD',
      is_fixture: true
    }
  };
  assert.throws(() => assertWebJobView(invalid), /must never allow Canonical promotion/);
});

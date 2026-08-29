import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { snapshotPathForDay } from '../../src/core/acquire-day.js';
import { sha256File, sha256Text } from '../../src/core/hash.js';
import { writeSourceSnapshot } from '../../src/core/source-snapshot.js';
import type { DailyAudit, SourceTick, SymbolRegistryEntry } from '../../src/types/contracts.js';
import type { MultiplierObservation, MultiplierProbeResult } from '../../src/precision/upstream-multiplier.js';
import { verifyPrecision } from '../../src/precision/verify.js';

const symbol: SymbolRegistryEntry = {
  canonical_symbol: 'EURUSD',
  enabled: true,
  source_adapter_id: 'dukascopy-node',
  source_instrument: 'eurusd',
  source_api_code: 'EUR-USD',
  source_api_code_provenance: 'fixture',
  source_feed_type: 'tick',
  source_start_hint_utc: '2003-05-04T00:00:00.000Z',
  source_start_hint_provenance: 'fixture',
  source_start_hint_status: 'REFERENCE_ONLY',
  precision_status: 'UNVERIFIED',
  price_digits: null,
  price_scale: null,
};

function probe(priceScale: number, digits: number, multiplierRaw: string): MultiplierProbeResult {
  const observations: MultiplierObservation[] = Array.from({ length: 24 }, (_, hour) => ({
    hour_utc: hour,
    endpoint_path: `/fixture/${hour}`,
    http_status: 200,
    response_sha256: sha256Text(`fixture-${hour}`),
    response_tick_delta_count: hour === 0 ? 3 : 0,
    multiplier_raw: hour === 0 ? multiplierRaw : null,
    multiplier_number_string: hour === 0 ? multiplierRaw : null,
    multiplier_normalized_key: hour === 0 ? `${1n}e-${digits}` : null,
    decoder_price_digits: hour === 0 ? digits : null,
    decoder_price_scale: hour === 0 ? priceScale : null,
  }));
  return {
    source_metadata_provenance: 'fixture multiplier contract',
    source_api_root: 'https://example.invalid/v1',
    source_api_code: 'EUR-USD',
    date_utc: '2026-01-05',
    observations,
    data_observation_count: 1,
    unique_multiplier_keys: [`1e-${digits}`],
    candidate_multiplier_raw: multiplierRaw,
    candidate_price_digits: digits,
    candidate_price_scale: priceScale,
    observation_hash: sha256Text('fixture-observation'),
  };
}

async function fixtureRun(): Promise<{ root: string; referencePath: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'hdh-precision-'));
  const dateUtc = '2026-01-05';
  const ticks: SourceTick[] = [
    { timestamp_msc: 1767571200001n, bid: 1.23456, ask: 1.23467, bid_volume: null, ask_volume: 2, source_seq: 0 },
    { timestamp_msc: 1767571200002n, bid: 1.23458, ask: 1.23469, bid_volume: 1, ask_volume: 2, source_seq: 1 },
    { timestamp_msc: 1767571200003n, bid: 1.23457, ask: 1.23468, bid_volume: 1, ask_volume: null, source_seq: 2 },
  ];
  const snapshotPath = snapshotPathForDay(root, symbol, dateUtc);
  await writeSourceSnapshot(snapshotPath, ticks);
  const snapshotSha = await sha256File(snapshotPath);
  const integrityDir = resolve(root, 'integrity');
  await mkdir(integrityDir, { recursive: true });
  const audit: DailyAudit = {
    date_utc: dateUtc,
    requested_from_utc: '2026-01-05T00:00:00.000Z',
    requested_to_utc: '2026-01-06T00:00:00.000Z',
    status: 'PASS',
    tick_count: 3,
    first_timestamp_msc: '1767571200001',
    last_timestamp_msc: '1767571200003',
    exact_duplicate_count: 0,
    same_timestamp_pair_count: 0,
    out_of_range_count: 0,
    out_of_order_count: 0,
    invalid_bid_count: 0,
    invalid_ask_count: 0,
    invalid_price_count: 0,
    negative_spread_count: 0,
    null_bid_volume_count: 1,
    null_ask_volume_count: 1,
    snapshot_path: 'fixture',
    snapshot_sha256: snapshotSha,
    failure_class: null,
    note: null,
  };
  await writeFile(resolve(integrityDir, 'daily_audit.jsonl'), `${JSON.stringify(audit)}\n`);
  const referencePath = resolve(root, 'reference.json');
  await writeFile(referencePath, JSON.stringify({ symbols: { EURUSD: { assessment: 'EXPLAINED_DIFFERENCE', blocking_difference: false } } }));
  return { root, referencePath };
}

test('precision verification promotes only exact decoder lattice', async () => {
  const fixture = await fixtureRun();
  try {
    const evidence = await verifyPrecision({
      symbol,
      dateUtc: '2026-01-05',
      sourceRunRoot: fixture.root,
      crossAdapterReferencePath: fixture.referencePath,
      verifierGitCommit: 'fixture-sha',
      multiplierProbe: probe(100000, 5, '0.00001'),
    });
    assert.equal(evidence.precision_status, 'VERIFIED');
    assert.equal(evidence.candidate_price_scale, 100000);
    assert.equal(evidence.bid_scaled_conversion_fail_count, 0);
    assert.equal(evidence.ask_scaled_conversion_fail_count, 0);
    assert.equal(evidence.observed_decimal_lattice_summary.minimum_positive_bid_delta_scaled, '1');
    assert.equal(evidence.observed_decimal_lattice_summary.minimum_positive_ask_delta_scaled, '1');
    assert.equal(evidence.upstream_multiplier.observations.length, 24);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('wrong scale remains UNVERIFIED instead of rounding', async () => {
  const fixture = await fixtureRun();
  try {
    const evidence = await verifyPrecision({
      symbol,
      dateUtc: '2026-01-05',
      sourceRunRoot: fixture.root,
      crossAdapterReferencePath: fixture.referencePath,
      verifierGitCommit: 'fixture-sha',
      multiplierProbe: probe(10000, 4, '0.0001'),
    });
    assert.equal(evidence.precision_status, 'UNVERIFIED');
    assert.equal(evidence.exact_lattice_pass, false);
    assert.equal(evidence.bid_scaled_conversion_fail_count, 3);
    assert.equal(evidence.ask_scaled_conversion_fail_count, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { snapshotPathForDay } from '../core/acquire-day.js';
import { sha256File, sha256Text } from '../core/hash.js';
import { loadLatestAudits } from '../core/resume.js';
import type { SymbolRegistryEntry } from '../types/contracts.js';
import {
  decimalToScaledIntExact,
  requiredDecimalPlaces,
} from './decimal.js';
import { probeUtcDayMultipliers, type MultiplierProbeResult } from './upstream-multiplier.js';

const JSON_NUMBER = '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';

function extractNumberField(line: string, field: string): string {
  const pattern = new RegExp(`"${field}"\\s*:\\s*(${JSON_NUMBER})`);
  const match = pattern.exec(line);
  if (!match?.[1]) throw new Error(`Snapshot line missing numeric ${field}`);
  return match[1];
}

function minPositive(current: bigint | null, previous: bigint | null, value: bigint): bigint | null {
  if (previous === null) return current;
  const delta = value >= previous ? value - previous : previous - value;
  if (delta === 0n) return current;
  return current === null || delta < current ? delta : current;
}

export interface PrecisionEvidence {
  schema_version: '0.1.0';
  symbol: string;
  source_adapter: 'dukascopy-node';
  source_adapter_version: '1.50.0';
  source_metadata_provenance: string;
  source_metadata_hash: string;
  observed_tick_window: {
    date_utc: string;
    source_snapshot_sha256: string;
    source_daily_audit_status: 'PASS';
  };
  observed_tick_count: number;
  upstream_tick_delta_count: number;
  upstream_multiplier: {
    raw: string;
    normalized_key: string;
    data_hour_count: number;
    observation_hash: string;
  };
  observed_decimal_lattice_summary: {
    max_bid_decimal_places: number;
    max_ask_decimal_places: number;
    minimum_positive_bid_delta_scaled: string | null;
    minimum_positive_ask_delta_scaled: string | null;
  };
  candidate_price_digits: number;
  candidate_price_scale: number;
  bid_scaled_conversion_fail_count: number;
  ask_scaled_conversion_fail_count: number;
  exact_lattice_pass: boolean;
  cross_adapter_findings: unknown;
  cross_adapter_reference_sha256: string;
  precision_status: 'VERIFIED' | 'UNVERIFIED';
  verification_reason: string;
  verifier_git_commit: string;
}

export interface VerifyPrecisionInput {
  symbol: SymbolRegistryEntry;
  dateUtc: string;
  sourceRunRoot: string;
  crossAdapterReferencePath: string;
  verifierGitCommit: string;
  multiplierProbe?: MultiplierProbeResult;
}

export async function verifyPrecision(input: VerifyPrecisionInput): Promise<PrecisionEvidence> {
  const auditPath = resolve(input.sourceRunRoot, 'integrity', 'daily_audit.jsonl');
  const audits = await loadLatestAudits(auditPath);
  const audit = audits.get(input.dateUtc);
  if (!audit || audit.status !== 'PASS' || !audit.snapshot_sha256) {
    throw new Error(`Precision verification requires a PASS source day: ${input.dateUtc}`);
  }

  const snapshotPath = snapshotPathForDay(input.sourceRunRoot, input.symbol, input.dateUtc);
  const snapshotSha = await sha256File(snapshotPath);
  if (snapshotSha !== audit.snapshot_sha256) {
    throw new Error(`Source snapshot hash mismatch for precision verification: ${input.dateUtc}`);
  }

  const probe = input.multiplierProbe ?? await probeUtcDayMultipliers(input.symbol, input.dateUtc);
  if (probe.candidate_multiplier_raw === null || probe.candidate_price_digits === null || probe.candidate_price_scale === null) {
    throw new Error('Upstream multiplier probe did not produce a precision candidate');
  }
  if (probe.unique_multiplier_keys.length !== 1) {
    throw new Error(`Precision verification requires one unique multiplier; got ${probe.unique_multiplier_keys.length}`);
  }

  const upstreamTickCount = probe.observations.reduce((sum, item) => sum + item.response_tick_delta_count, 0);
  if (upstreamTickCount !== audit.tick_count) {
    throw new Error(`Precision metadata tick count does not match Source Snapshot: metadata=${upstreamTickCount} source=${audit.tick_count}`);
  }

  const compressed = await readFile(snapshotPath);
  const text = gunzipSync(compressed).toString('utf8');
  const lines = text.length === 0 ? [] : text.trimEnd().split('\n');
  if (lines.length !== audit.tick_count) {
    throw new Error(`Snapshot line count does not match daily audit: lines=${lines.length} audit=${audit.tick_count}`);
  }

  let bidFailures = 0;
  let askFailures = 0;
  let maxBidDecimalPlaces = 0;
  let maxAskDecimalPlaces = 0;
  let previousBid: bigint | null = null;
  let previousAsk: bigint | null = null;
  let minimumBidDelta: bigint | null = null;
  let minimumAskDelta: bigint | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const bidRaw = extractNumberField(line, 'bid');
    const askRaw = extractNumberField(line, 'ask');
    const parsed = JSON.parse(line) as { source_seq?: unknown };
    if (parsed.source_seq !== index) throw new Error(`Source order mismatch at precision row ${index}`);

    maxBidDecimalPlaces = Math.max(maxBidDecimalPlaces, requiredDecimalPlaces(bidRaw));
    maxAskDecimalPlaces = Math.max(maxAskDecimalPlaces, requiredDecimalPlaces(askRaw));

    const bidScaled = decimalToScaledIntExact(bidRaw, probe.candidate_price_scale);
    const askScaled = decimalToScaledIntExact(askRaw, probe.candidate_price_scale);
    if (bidScaled === null) {
      bidFailures += 1;
    } else {
      minimumBidDelta = minPositive(minimumBidDelta, previousBid, bidScaled);
      previousBid = bidScaled;
    }
    if (askScaled === null) {
      askFailures += 1;
    } else {
      minimumAskDelta = minPositive(minimumAskDelta, previousAsk, askScaled);
      previousAsk = askScaled;
    }
  }

  const referenceText = await readFile(input.crossAdapterReferencePath, 'utf8');
  const reference = JSON.parse(referenceText) as { symbols?: Record<string, unknown> };
  const crossAdapterFindings = reference.symbols?.[input.symbol.canonical_symbol];
  if (!crossAdapterFindings) throw new Error(`Missing accepted cross-adapter reference for ${input.symbol.canonical_symbol}`);
  const blocking = (crossAdapterFindings as { blocking_difference?: unknown }).blocking_difference;
  if (blocking !== false) throw new Error(`Cross-adapter reference is blocking for ${input.symbol.canonical_symbol}`);

  const exactLatticePass = bidFailures === 0 && askFailures === 0;
  const verified = exactLatticePass && lines.length > 0;
  const verificationReason = verified
    ? `Actual Dukascopy JSON multiplier was stable across ${probe.data_observation_count} non-empty UTC hours; decoder-derived scale converted all ${lines.length} Source Snapshot Bid/Ask values to exact integers without rounding; source hash/order/count and accepted R06 cross-adapter evidence matched.`
    : `Exact scaled-integer conversion failed: bid=${bidFailures} ask=${askFailures}`;

  return {
    schema_version: '0.1.0',
    symbol: input.symbol.canonical_symbol,
    source_adapter: 'dukascopy-node',
    source_adapter_version: '1.50.0',
    source_metadata_provenance: probe.source_metadata_provenance,
    source_metadata_hash: probe.observation_hash,
    observed_tick_window: {
      date_utc: input.dateUtc,
      source_snapshot_sha256: snapshotSha,
      source_daily_audit_status: 'PASS',
    },
    observed_tick_count: lines.length,
    upstream_tick_delta_count: upstreamTickCount,
    upstream_multiplier: {
      raw: probe.candidate_multiplier_raw,
      normalized_key: probe.unique_multiplier_keys[0]!,
      data_hour_count: probe.data_observation_count,
      observation_hash: probe.observation_hash,
    },
    observed_decimal_lattice_summary: {
      max_bid_decimal_places: maxBidDecimalPlaces,
      max_ask_decimal_places: maxAskDecimalPlaces,
      minimum_positive_bid_delta_scaled: minimumBidDelta?.toString() ?? null,
      minimum_positive_ask_delta_scaled: minimumAskDelta?.toString() ?? null,
    },
    candidate_price_digits: probe.candidate_price_digits,
    candidate_price_scale: probe.candidate_price_scale,
    bid_scaled_conversion_fail_count: bidFailures,
    ask_scaled_conversion_fail_count: askFailures,
    exact_lattice_pass: exactLatticePass,
    cross_adapter_findings: crossAdapterFindings,
    cross_adapter_reference_sha256: sha256Text(referenceText),
    precision_status: verified ? 'VERIFIED' : 'UNVERIFIED',
    verification_reason: verificationReason,
    verifier_git_commit: input.verifierGitCommit,
  };
}

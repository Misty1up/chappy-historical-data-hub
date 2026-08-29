import { sha256Text } from '../core/hash.js';
import {
  PROJECT_DEFAULT_MAX_ATTEMPTS,
  waitBeforeRetry,
} from '../core/retry-policy.js';
import type { SymbolRegistryEntry } from '../types/contracts.js';
import { decoderPriceDigitsFromMultiplierRaw, normalizedDecimalKey } from './decimal.js';

export const DUKASCOPY_DATA_API_ROOT = 'https://jetta.dukascopy.com/v1';

export interface MultiplierObservation {
  hour_utc: number;
  endpoint_path: string;
  http_status: number;
  response_sha256: string;
  response_tick_delta_count: number;
  multiplier_raw: string | null;
  multiplier_number_string: string | null;
  multiplier_normalized_key: string | null;
  decoder_price_digits: number | null;
  decoder_price_scale: number | null;
}

export interface MultiplierProbeResult {
  source_metadata_provenance: string;
  source_api_root: string;
  source_api_code: string;
  date_utc: string;
  observations: MultiplierObservation[];
  data_observation_count: number;
  unique_multiplier_keys: string[];
  candidate_multiplier_raw: string | null;
  candidate_price_digits: number | null;
  candidate_price_scale: number | null;
  observation_hash: string;
}

const JSON_NUMBER = '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
const MULTIPLIER_PATTERN = new RegExp(`"multiplier"\\s*:\\s*(${JSON_NUMBER})`);

function parseUtcDate(dateUtc: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) throw new Error(`date must be YYYY-MM-DD: ${dateUtc}`);
  const date = new Date(`${dateUtc}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateUtc) {
    throw new Error(`Invalid UTC calendar date: ${dateUtc}`);
  }
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

async function fetchTextWithProjectRetry(url: string): Promise<{ status: number; text: string }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PROJECT_DEFAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await response.text();
      if (response.ok) return { status: response.status, text };
      lastError = new Error(`Precision metadata request failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < PROJECT_DEFAULT_MAX_ATTEMPTS) await waitBeforeRetry(attempt);
  }
  throw lastError instanceof Error ? lastError : new Error('Precision metadata request failed');
}

export async function probeUtcDayMultipliers(
  symbol: SymbolRegistryEntry,
  dateUtc: string,
): Promise<MultiplierProbeResult> {
  const { year, month, day } = parseUtcDate(dateUtc);
  const observations: MultiplierObservation[] = [];

  for (let hour = 0; hour < 24; hour += 1) {
    const endpointPath = `/ticks/${symbol.source_api_code}/${year}/${month}/${day}/${hour}`;
    const { status, text } = await fetchTextWithProjectRetry(`${DUKASCOPY_DATA_API_ROOT}${endpointPath}`);
    const parsed = JSON.parse(text) as { times?: unknown; multiplier?: unknown };
    if (!Array.isArray(parsed.times)) throw new Error(`Upstream precision payload missing times[] for hour ${hour}`);

    const match = MULTIPLIER_PATTERN.exec(text);
    const multiplierRaw = match?.[1] ?? null;
    let multiplierNumberString: string | null = null;
    let multiplierNormalizedKey: string | null = null;
    let decoderPriceDigits: number | null = null;
    let decoderPriceScale: number | null = null;

    if (multiplierRaw !== null) {
      const derived = decoderPriceDigitsFromMultiplierRaw(multiplierRaw);
      multiplierNumberString = derived.multiplierNumberString;
      multiplierNormalizedKey = normalizedDecimalKey(multiplierNumberString);
      decoderPriceDigits = derived.priceDigits;
      decoderPriceScale = derived.priceScale;
    } else if (parsed.times.length > 0) {
      throw new Error(`Non-empty upstream precision payload missing multiplier for hour ${hour}`);
    }

    observations.push({
      hour_utc: hour,
      endpoint_path: endpointPath,
      http_status: status,
      response_sha256: sha256Text(text),
      response_tick_delta_count: parsed.times.length,
      multiplier_raw: multiplierRaw,
      multiplier_number_string: multiplierNumberString,
      multiplier_normalized_key: multiplierNormalizedKey,
      decoder_price_digits: decoderPriceDigits,
      decoder_price_scale: decoderPriceScale,
    });
  }

  const dataObservations = observations.filter(item => item.response_tick_delta_count > 0);
  const multiplierKeys = [...new Set(dataObservations.map(item => item.multiplier_normalized_key).filter((value): value is string => value !== null))].sort();
  if (dataObservations.length === 0) throw new Error(`No upstream tick data observations for ${symbol.canonical_symbol} ${dateUtc}`);
  if (multiplierKeys.length !== 1) {
    throw new Error(`Expected exactly one multiplier across non-empty hours; found ${multiplierKeys.length}`);
  }

  const first = dataObservations.find(item => item.multiplier_normalized_key === multiplierKeys[0])!;
  const evidenceInput = observations.map(item => [
    item.hour_utc,
    item.endpoint_path,
    item.http_status,
    item.response_sha256,
    item.response_tick_delta_count,
    item.multiplier_normalized_key ?? 'NONE',
    item.decoder_price_digits ?? 'NONE',
    item.decoder_price_scale ?? 'NONE',
  ].join('|')).join('\n');

  return {
    source_metadata_provenance: `${symbol.source_api_code_provenance}; dukascopy-node v1.50.0 data API root and multiplier decoder contract`,
    source_api_root: DUKASCOPY_DATA_API_ROOT,
    source_api_code: symbol.source_api_code,
    date_utc: dateUtc,
    observations,
    data_observation_count: dataObservations.length,
    unique_multiplier_keys: multiplierKeys,
    candidate_multiplier_raw: first.multiplier_raw,
    candidate_price_digits: first.decoder_price_digits,
    candidate_price_scale: first.decoder_price_scale,
    observation_hash: sha256Text(`${evidenceInput}\n`),
  };
}

import type { CanonicalDayResult } from '../canonical/types.js';
import { decimalToScaledIntExact, powerOfTenDigits } from '../precision/decimal.js';
import { MT5_DERIVATIVE_PROFILE_ID, type Mt5TickDerivativeDay, type Mt5TickDerivativeRow } from './types.js';

export function formatScaledPrice(scaled: bigint, priceDigits: number): string {
  if (!Number.isSafeInteger(priceDigits) || priceDigits < 0) {
    throw new Error(`priceDigits must be a non-negative safe integer: ${priceDigits}`);
  }

  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  if (priceDigits === 0) return `${negative ? '-' : ''}${absolute.toString()}`;

  const digits = absolute.toString().padStart(priceDigits + 1, '0');
  const split = digits.length - priceDigits;
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function assertCanonicalPriceRoundTrip(
  label: 'bid' | 'ask',
  value: number,
  scaled: bigint,
  priceDigits: number,
  priceScale: number,
  sourceSeq: number,
): string {
  const text = formatScaledPrice(scaled, priceDigits);
  const reparsedScaled = decimalToScaledIntExact(text, priceScale);
  if (reparsedScaled !== scaled) {
    throw new Error(`${label} scaled roundtrip failed at source_seq=${sourceSeq}`);
  }
  const reparsedNumber = Number(text);
  if (!Number.isFinite(reparsedNumber) || !Object.is(reparsedNumber, value)) {
    throw new Error(`${label} float/scaled semantic mismatch at source_seq=${sourceSeq}: canonical=${value} scaled=${text}`);
  }
  return text;
}

export function deriveMt5TickDerivativeDay(canonical: CanonicalDayResult): Mt5TickDerivativeDay {
  if (canonical.rows.length === 0) throw new Error('MT5 derivative requires at least one Canonical tick');
  if (canonical.source_row_count !== canonical.rows.length || canonical.canonical_row_count !== canonical.rows.length) {
    throw new Error(
      `Canonical row count mismatch before MT5 derivation: source=${canonical.source_row_count} canonical=${canonical.canonical_row_count} rows=${canonical.rows.length}`,
    );
  }

  const scaleDigits = powerOfTenDigits(canonical.price_scale);
  if (scaleDigits !== canonical.price_digits) {
    throw new Error(`price_digits/price_scale mismatch: digits=${canonical.price_digits} scale=${canonical.price_scale}`);
  }

  const first = canonical.rows[0]!;
  const last = canonical.rows.at(-1)!;
  if (canonical.first_timestamp_msc !== first.timestamp_msc.toString()) {
    throw new Error('Canonical first_timestamp_msc does not match first row');
  }
  if (canonical.last_timestamp_msc !== last.timestamp_msc.toString()) {
    throw new Error('Canonical last_timestamp_msc does not match last row');
  }

  const rows: Mt5TickDerivativeRow[] = [];
  let previousTime: bigint | null = null;
  for (let index = 0; index < canonical.rows.length; index += 1) {
    const row = canonical.rows[index]!;
    if (row.source_seq !== index) {
      throw new Error(`Canonical source_seq discontinuity at row=${index}: ${row.source_seq}`);
    }
    if (previousTime !== null && row.timestamp_msc < previousTime) {
      throw new Error(
        `MT5 requires nondecreasing time but Canonical source order decreases at source_seq=${row.source_seq}: ${row.timestamp_msc} < ${previousTime}; sorting is forbidden`,
      );
    }
    if (row.bid_scaled > row.ask_scaled) {
      throw new Error(`Canonical negative spread before MT5 derivation at source_seq=${row.source_seq}`);
    }

    const bid = assertCanonicalPriceRoundTrip(
      'bid',
      row.bid,
      row.bid_scaled,
      canonical.price_digits,
      canonical.price_scale,
      row.source_seq,
    );
    const ask = assertCanonicalPriceRoundTrip(
      'ask',
      row.ask,
      row.ask_scaled,
      canonical.price_digits,
      canonical.price_scale,
      row.source_seq,
    );

    rows.push({
      time_msc: row.timestamp_msc,
      source_seq: row.source_seq,
      bid,
      ask,
      bid_scaled: row.bid_scaled,
      ask_scaled: row.ask_scaled,
    });
    previousTime = row.timestamp_msc;
  }

  return {
    schema_version: '0.1.0',
    profile_id: MT5_DERIVATIVE_PROFILE_ID,
    symbol: canonical.symbol,
    date_utc: canonical.date_utc,
    price_digits: canonical.price_digits,
    price_scale: canonical.price_scale,
    source_snapshot_sha256: canonical.source_snapshot_sha256,
    canonical_logical_row_sha256: canonical.logical_row_sha256,
    canonical_row_count: canonical.canonical_row_count,
    from_msc: first.timestamp_msc,
    to_msc: last.timestamp_msc,
    order_policy: 'SOURCE_SEQ_PRESERVED_NONDECREASING_TIME',
    same_timestamp_policy: 'PRESERVED',
    dedupe_applied: false,
    gap_fill_applied: false,
    bid_ask_mapping: 'DIRECT_FROM_CANONICAL_SCALED',
    volume_mapping_policy: 'UNMAPPED_BID_ASK_VOLUME_REMAINS_CANONICAL_ONLY',
    dataset_binding_status: 'PENDING_P2_5_PACKET',
    rows,
  };
}

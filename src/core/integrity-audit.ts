import type { DailyAudit, SourceTick, UtcDayWindow } from '../types/contracts.js';

function duplicateKey(tick: SourceTick): string {
  return JSON.stringify([
    tick.timestamp_msc.toString(10),
    tick.bid,
    tick.ask,
    tick.bid_volume,
    tick.ask_volume,
  ]);
}

function failureClassForAudit(input: {
  ticksLength: number;
  outOfRangeCount: number;
  outOfOrderCount: number;
  invalidBidCount: number;
  invalidAskCount: number;
  negativeSpreadCount: number;
}): string | null {
  if (input.ticksLength === 0) return 'EMPTY_UNCLASSIFIED';
  if (input.outOfRangeCount > 0) return 'TIMESTAMP_OUT_OF_RANGE';
  if (input.outOfOrderCount > 0) return 'NON_MONOTONIC_INPUT';
  if (input.invalidBidCount > 0) return 'INVALID_BID';
  if (input.invalidAskCount > 0) return 'INVALID_ASK';
  if (input.negativeSpreadCount > 0) return 'NEGATIVE_SPREAD';
  return null;
}

export function auditSourceTicks(dateUtc: string, ticks: SourceTick[], window?: UtcDayWindow): DailyAudit {
  let exactDuplicateCount = 0;
  let sameTimestampPairCount = 0;
  let outOfRangeCount = 0;
  let outOfOrderCount = 0;
  let invalidBidCount = 0;
  let invalidAskCount = 0;
  let negativeSpreadCount = 0;
  let nullBidVolumeCount = 0;
  let nullAskVolumeCount = 0;

  const seenRows = new Set<string>();
  const seenTimestamps = new Set<string>();
  let previousTimestamp: bigint | null = null;
  const rangeFrom = window ? BigInt(window.fromUtc.getTime()) : null;
  const rangeTo = window ? BigInt(window.toUtc.getTime()) : null;

  for (const tick of ticks) {
    const rowKey = duplicateKey(tick);
    if (seenRows.has(rowKey)) exactDuplicateCount += 1;
    else seenRows.add(rowKey);

    const timestampKey = tick.timestamp_msc.toString(10);
    if (seenTimestamps.has(timestampKey)) sameTimestampPairCount += 1;
    else seenTimestamps.add(timestampKey);

    if (rangeFrom !== null && rangeTo !== null && (tick.timestamp_msc < rangeFrom || tick.timestamp_msc >= rangeTo)) {
      outOfRangeCount += 1;
    }

    if (previousTimestamp !== null && tick.timestamp_msc < previousTimestamp) outOfOrderCount += 1;
    previousTimestamp = tick.timestamp_msc;

    const invalidBid = !Number.isFinite(tick.bid) || tick.bid <= 0;
    const invalidAsk = !Number.isFinite(tick.ask) || tick.ask <= 0;
    if (invalidBid) invalidBidCount += 1;
    if (invalidAsk) invalidAskCount += 1;
    if (!invalidBid && !invalidAsk && tick.ask < tick.bid) negativeSpreadCount += 1;

    if (tick.bid_volume === null) nullBidVolumeCount += 1;
    if (tick.ask_volume === null) nullAskVolumeCount += 1;
  }

  const invalidPriceCount = invalidBidCount + invalidAskCount;
  const failureClass = failureClassForAudit({
    ticksLength: ticks.length,
    outOfRangeCount,
    outOfOrderCount,
    invalidBidCount,
    invalidAskCount,
    negativeSpreadCount,
  });
  const hardFailure = ticks.length > 0 && failureClass !== null;
  const status = hardFailure ? 'FAIL' : ticks.length === 0 ? 'WARN' : 'PASS';

  return {
    date_utc: dateUtc,
    requested_from_utc: window?.fromUtc.toISOString() ?? null,
    requested_to_utc: window?.toUtc.toISOString() ?? null,
    status,
    tick_count: ticks.length,
    first_timestamp_msc: ticks.length ? ticks[0]!.timestamp_msc.toString(10) : null,
    last_timestamp_msc: ticks.length ? ticks[ticks.length - 1]!.timestamp_msc.toString(10) : null,
    exact_duplicate_count: exactDuplicateCount,
    same_timestamp_pair_count: sameTimestampPairCount,
    out_of_range_count: outOfRangeCount,
    out_of_order_count: outOfOrderCount,
    invalid_bid_count: invalidBidCount,
    invalid_ask_count: invalidAskCount,
    invalid_price_count: invalidPriceCount,
    negative_spread_count: negativeSpreadCount,
    null_bid_volume_count: nullBidVolumeCount,
    null_ask_volume_count: nullAskVolumeCount,
    snapshot_path: null,
    snapshot_sha256: null,
    failure_class: failureClass,
    note: ticks.length === 0 ? 'Empty source response; market-closed classification is deferred.' : null,
  };
}

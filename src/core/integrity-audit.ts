import type { DailyAudit, SourceTick } from '../types/contracts.js';

function duplicateKey(tick: SourceTick): string {
  return JSON.stringify([
    tick.timestamp_msc.toString(10),
    tick.bid,
    tick.ask,
    tick.bid_volume,
    tick.ask_volume,
  ]);
}

export function auditSourceTicks(dateUtc: string, ticks: SourceTick[]): DailyAudit {
  let exactDuplicateCount = 0;
  let sameTimestampPairCount = 0;
  let outOfOrderCount = 0;
  let invalidPriceCount = 0;
  let negativeSpreadCount = 0;
  let nullBidVolumeCount = 0;
  let nullAskVolumeCount = 0;

  const seenRows = new Set<string>();
  const seenTimestamps = new Set<string>();
  let previousTimestamp: bigint | null = null;

  for (const tick of ticks) {
    const rowKey = duplicateKey(tick);
    if (seenRows.has(rowKey)) exactDuplicateCount += 1;
    else seenRows.add(rowKey);

    const timestampKey = tick.timestamp_msc.toString(10);
    if (seenTimestamps.has(timestampKey)) sameTimestampPairCount += 1;
    else seenTimestamps.add(timestampKey);

    if (previousTimestamp !== null && tick.timestamp_msc < previousTimestamp) outOfOrderCount += 1;
    previousTimestamp = tick.timestamp_msc;

    if (!Number.isFinite(tick.bid) || !Number.isFinite(tick.ask) || tick.bid <= 0 || tick.ask <= 0) {
      invalidPriceCount += 1;
    } else if (tick.ask < tick.bid) {
      negativeSpreadCount += 1;
    }

    if (tick.bid_volume === null) nullBidVolumeCount += 1;
    if (tick.ask_volume === null) nullAskVolumeCount += 1;
  }

  const hardFailure = outOfOrderCount > 0 || invalidPriceCount > 0 || negativeSpreadCount > 0;
  const status = hardFailure ? 'FAIL' : ticks.length === 0 ? 'WARN' : 'PASS';

  return {
    date_utc: dateUtc,
    status,
    tick_count: ticks.length,
    first_timestamp_msc: ticks.length ? ticks[0]!.timestamp_msc.toString(10) : null,
    last_timestamp_msc: ticks.length ? ticks[ticks.length - 1]!.timestamp_msc.toString(10) : null,
    exact_duplicate_count: exactDuplicateCount,
    same_timestamp_pair_count: sameTimestampPairCount,
    out_of_order_count: outOfOrderCount,
    invalid_price_count: invalidPriceCount,
    negative_spread_count: negativeSpreadCount,
    null_bid_volume_count: nullBidVolumeCount,
    null_ask_volume_count: nullAskVolumeCount,
    snapshot_path: null,
    snapshot_sha256: null,
    failure_class: ticks.length === 0 ? 'EMPTY_UNCLASSIFIED' : hardFailure ? 'INTEGRITY_FAILURE' : null,
    note: ticks.length === 0 ? 'Empty source response; market-closed classification is deferred.' : null,
  };
}

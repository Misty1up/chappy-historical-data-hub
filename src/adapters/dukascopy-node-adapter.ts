import { getHistoricalRates } from 'dukascopy-node';
import type { AcquisitionAdapter } from './acquisition-adapter.js';
import type { FetchTicksOptions, SourceTick, SymbolRegistryEntry } from '../types/contracts.js';

type DukascopyTick = {
  timestamp: number;
  askPrice: number;
  bidPrice: number;
  askVolume?: number | null;
  bidVolume?: number | null;
};

function finiteOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) throw new Error(`Non-finite volume received: ${String(value)}`);
  return value;
}

export class DukascopyNodeAdapter implements AcquisitionAdapter {
  readonly adapterId = 'dukascopy-node';
  readonly adapterVersion = '0.1.0';

  async fetchTicks(
    symbol: SymbolRegistryEntry,
    fromUtc: Date,
    toUtc: Date,
    options: FetchTicksOptions,
  ): Promise<SourceTick[]> {
    const raw = await getHistoricalRates({
      instrument: symbol.source_instrument as never,
      dates: { from: fromUtc, to: toUtc },
      timeframe: 'tick' as never,
      format: 'json' as never,
      batchSize: options.batchSize,
      pauseBetweenBatchesMs: options.pauseBetweenBatchesMs,
    } as never);

    if (!Array.isArray(raw)) {
      throw new Error(`Unexpected dukascopy-node payload type: ${typeof raw}`);
    }

    return (raw as DukascopyTick[]).map((tick, sourceSeq) => {
      if (!Number.isSafeInteger(tick.timestamp)) {
        throw new Error(`Unsafe or invalid timestamp at source_seq=${sourceSeq}: ${String(tick.timestamp)}`);
      }
      if (!Number.isFinite(tick.bidPrice) || !Number.isFinite(tick.askPrice)) {
        throw new Error(`Non-finite Bid/Ask at source_seq=${sourceSeq}`);
      }
      return {
        timestamp_msc: BigInt(tick.timestamp),
        bid: tick.bidPrice,
        ask: tick.askPrice,
        bid_volume: finiteOrNull(tick.bidVolume),
        ask_volume: finiteOrNull(tick.askVolume),
        source_seq: sourceSeq,
      };
    });
  }
}

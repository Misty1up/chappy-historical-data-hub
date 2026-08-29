import { getHistoricalRates } from 'dukascopy-node';
import type { ConfigJsonTickItem, InstrumentType, JsonItemTick } from 'dukascopy-node';
import type { AcquisitionAdapter } from './acquisition-adapter.js';
import type { FetchTicksOptions, SourceTick, SymbolRegistryEntry } from '../types/contracts.js';

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
    const config: ConfigJsonTickItem = {
      instrument: symbol.source_instrument as InstrumentType,
      dates: { from: fromUtc, to: toUtc },
      timeframe: 'tick',
      format: 'json',
      utcOffset: 0,
      volumes: true,
      volumeUnits: 'units',
      ignoreFlats: false,
      batchSize: options.batchSize,
      pauseBetweenBatchesMs: options.pauseBetweenBatchesMs,
      useCache: false,
      retryCount: 0,
      retryOnEmpty: false,
      failAfterRetryCount: true,
    };

    const raw: JsonItemTick[] = await getHistoricalRates(config);
    if (!Array.isArray(raw)) {
      throw new Error(`Unexpected dukascopy-node payload type: ${typeof raw}`);
    }

    return raw.map((tick, sourceSeq) => {
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

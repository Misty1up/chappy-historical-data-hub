import type { FetchTicksOptions, SourceTick, SymbolRegistryEntry } from '../types/contracts.js';

export interface AcquisitionAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  fetchTicks(
    symbol: SymbolRegistryEntry,
    fromUtc: Date,
    toUtc: Date,
    options: FetchTicksOptions,
  ): Promise<SourceTick[]>;
}

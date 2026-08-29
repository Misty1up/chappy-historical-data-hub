import { readFile } from 'node:fs/promises';
import type { SymbolRegistry, SymbolRegistryEntry } from '../types/contracts.js';

function assertRegistryEntry(value: unknown): asserts value is SymbolRegistryEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid symbol registry entry');
  const entry = value as Record<string, unknown>;
  if (typeof entry.canonical_symbol !== 'string' || !/^[A-Z0-9._-]+$/.test(entry.canonical_symbol)) {
    throw new Error('Invalid canonical_symbol');
  }
  if (entry.enabled !== true && entry.enabled !== false) throw new Error('Invalid enabled flag');
  if (entry.source_adapter_id !== 'dukascopy-node') throw new Error('Unsupported source_adapter_id');
  if (typeof entry.source_instrument !== 'string' || !entry.source_instrument) throw new Error('Invalid source_instrument');
  if (typeof entry.source_api_code !== 'string' || !/^[A-Z0-9._-]+$/.test(entry.source_api_code)) {
    throw new Error('Invalid source_api_code');
  }
  if (typeof entry.source_api_code_provenance !== 'string' || !entry.source_api_code_provenance) {
    throw new Error('Invalid source_api_code_provenance');
  }
  if (entry.source_feed_type !== 'tick') throw new Error('Only tick feed is allowed');
  if (entry.precision_status !== 'UNVERIFIED' && entry.precision_status !== 'VERIFIED') {
    throw new Error('Invalid precision_status');
  }
  if (entry.source_start_hint_status !== 'REFERENCE_ONLY' && entry.source_start_hint_status !== 'VERIFIED_BY_FETCH') {
    throw new Error('Invalid source_start_hint_status');
  }
  const digits = entry.price_digits;
  const scale = entry.price_scale;
  if (entry.precision_status === 'UNVERIFIED') {
    if (digits !== null || scale !== null) throw new Error('UNVERIFIED precision requires null price_digits/price_scale');
  } else {
    if (!Number.isInteger(digits) || (digits as number) < 0) throw new Error('VERIFIED precision requires integer price_digits');
    if (!Number.isSafeInteger(scale) || (scale as number) < 1) throw new Error('VERIFIED precision requires positive safe-integer price_scale');
  }
}

export async function loadSymbolRegistry(path: string): Promise<SymbolRegistry> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid symbol registry root');
  const root = parsed as Record<string, unknown>;
  if (typeof root.schema_version !== 'string' || !Array.isArray(root.symbols)) {
    throw new Error('Invalid symbol registry structure');
  }
  root.symbols.forEach(assertRegistryEntry);
  return parsed as SymbolRegistry;
}

export function resolveSymbol(registry: SymbolRegistry, canonicalSymbol: string): SymbolRegistryEntry {
  const normalized = canonicalSymbol.toUpperCase();
  const match = registry.symbols.find(item => item.canonical_symbol === normalized && item.enabled);
  if (!match) throw new Error(`Symbol is not enabled in registry: ${normalized}`);
  return match;
}

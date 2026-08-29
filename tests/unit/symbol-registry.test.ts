import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadSymbolRegistry, resolveSymbol } from '../../src/core/symbol-registry.js';

async function withRegistry(value: unknown, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(resolve(tmpdir(), 'hdh-registry-'));
  try {
    const path = resolve(dir, 'registry.json');
    await writeFile(path, JSON.stringify(value));
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const valid = {
  schema_version: '0.2.0',
  symbols: [{
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
  }],
};

test('valid registry loads and symbol resolution is case-insensitive at CLI boundary', async () => {
  await withRegistry(valid, async path => {
    const registry = await loadSymbolRegistry(path);
    assert.equal(resolveSymbol(registry, 'eurusd').source_instrument, 'eurusd');
    assert.equal(resolveSymbol(registry, 'eurusd').source_api_code, 'EUR-USD');
  });
});

test('invalid adapter is rejected', async () => {
  const invalid = structuredClone(valid);
  invalid.symbols[0]!.source_adapter_id = 'other';
  await withRegistry(invalid, async path => {
    await assert.rejects(() => loadSymbolRegistry(path), /Unsupported source_adapter_id/);
  });
});

test('disabled or unknown symbol cannot be resolved', async () => {
  const disabled = structuredClone(valid);
  disabled.symbols[0]!.enabled = false;
  await withRegistry(disabled, async path => {
    const registry = await loadSymbolRegistry(path);
    assert.throws(() => resolveSymbol(registry, 'EURUSD'), /not enabled/);
  });
});

test('UNVERIFIED precision cannot carry guessed digits or scale', async () => {
  const invalid = structuredClone(valid);
  invalid.symbols[0]!.price_digits = 5;
  invalid.symbols[0]!.price_scale = 100000;
  await withRegistry(invalid, async path => {
    await assert.rejects(() => loadSymbolRegistry(path), /UNVERIFIED precision requires null/);
  });
});

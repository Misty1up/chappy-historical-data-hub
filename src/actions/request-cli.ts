import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAndValidateActionRequestJson } from './request.js';
import type { WebSymbolContract } from '../web/contract.js';

interface RegistryFile {
  symbols?: Array<{
    canonical_symbol?: unknown;
    enabled?: unknown;
    precision_status?: unknown;
  }>;
}

async function loadSymbols(registryPath: string): Promise<WebSymbolContract[]> {
  const raw = await readFile(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as RegistryFile;
  if (!Array.isArray(parsed.symbols)) throw new Error('symbol registry must contain symbols[]');
  return parsed.symbols.map((item, index) => {
    if (typeof item.canonical_symbol !== 'string') throw new Error(`symbol registry row ${index} canonical_symbol invalid`);
    if (typeof item.enabled !== 'boolean') throw new Error(`symbol registry row ${index} enabled invalid`);
    if (item.precision_status !== 'VERIFIED' && item.precision_status !== 'UNVERIFIED') {
      throw new Error(`symbol registry row ${index} precision_status invalid`);
    }
    return {
      canonical_symbol: item.canonical_symbol,
      enabled: item.enabled,
      precision_status: item.precision_status
    };
  });
}

async function main(): Promise<void> {
  const requestJson = process.env.HDH_REQUEST_JSON;
  if (!requestJson) throw new Error('HDH_REQUEST_JSON is required');

  const registryPath = process.env.HDH_SYMBOL_REGISTRY ?? 'config/symbol_registry.json';
  const symbols = await loadSymbols(registryPath);
  const validated = parseAndValidateActionRequestJson(requestJson, symbols);
  if (!validated.ok || !validated.request || !validated.serialized_request) {
    for (const error of validated.errors) console.error(`REQUEST_VALIDATION_ERROR: ${error}`);
    process.exitCode = 2;
    return;
  }

  const outDir = process.env.HDH_ACTION_PREFLIGHT_DIR ?? '.hdh-phase4';
  await mkdir(outDir, { recursive: true });
  const normalizedPath = path.join(outDir, 'validated-request.json');
  await writeFile(normalizedPath, validated.serialized_request, 'utf8');

  // Execution de-duplication key only. This is NOT dataset_id or a data-authority hash.
  const requestKey = createHash('sha256').update(validated.serialized_request, 'utf8').digest('hex');
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(githubOutput, `request_key=${requestKey}\nnormalized_request_path=${normalizedPath}\n`, 'utf8');
  }

  console.log(`Phase 4 request validation PASS: ${validated.request.symbol} ${validated.request.mode}`);
  console.log(`Execution request key: ${requestKey}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

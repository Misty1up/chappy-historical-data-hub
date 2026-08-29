#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { buildDatasetPacket } from './packet/build.js';
import { loadSymbolRegistry, resolveSymbol } from './core/symbol-registry.js';

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options.set(key, value);
  }
  return options;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function resolveSafeRelativePath(pathArg: string, optionName: string): string {
  if (isAbsolute(pathArg)) throw new Error(`--${optionName} must be a relative path`);
  const cwd = resolve(process.cwd());
  const resolved = resolve(cwd, pathArg);
  const rel = relative(cwd, resolved);
  if (!rel || rel === '.' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`--${optionName} must resolve inside the current working directory`);
  }
  return resolved;
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const symbolArg = required(options, 'symbol').toUpperCase();
  const sourceRunRoot = resolveSafeRelativePath(required(options, 'source-run'), 'source-run');
  const precisionEvidencePath = resolveSafeRelativePath(required(options, 'precision-evidence'), 'precision-evidence');
  const canonicalRoot = resolveSafeRelativePath(required(options, 'canonical-root'), 'canonical-root');
  const mt5Root = resolveSafeRelativePath(required(options, 'mt5-root'), 'mt5-root');
  const outRoot = resolveSafeRelativePath(required(options, 'out'), 'out');
  const registry = await loadSymbolRegistry(resolve(process.cwd(), 'config', 'symbol_registry.json'));
  const symbol = resolveSymbol(registry, symbolArg);

  const result = await buildDatasetPacket({
    symbol,
    sourceRunRoot,
    precisionEvidencePath,
    canonicalRoot,
    mt5Root,
    outRoot,
    generatorGitCommit: gitCommit(),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

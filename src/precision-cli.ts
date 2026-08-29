#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { atomicWriteFile } from './core/atomic-write.js';
import { loadSymbolRegistry, resolveSymbol } from './core/symbol-registry.js';
import { verifyPrecision } from './precision/verify.js';

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
  const dateUtc = required(options, 'date');
  const sourceRunArg = required(options, 'source-run');
  const outArg = required(options, 'out');
  const sourceRunRoot = resolveSafeRelativePath(sourceRunArg, 'source-run');
  const outRoot = resolveSafeRelativePath(outArg, 'out');
  if (sourceRunRoot === outRoot) throw new Error('--source-run and --out must be different directories');

  const registry = await loadSymbolRegistry(resolve(process.cwd(), 'config', 'symbol_registry.json'));
  const symbol = resolveSymbol(registry, symbolArg);
  const verifierGitCommit = gitCommit();
  const crossAdapterReferencePath = resolve(process.cwd(), 'config', 'precision_cross_adapter_reference.json');

  await mkdir(outRoot, { recursive: true });
  const evidence = await verifyPrecision({
    symbol,
    dateUtc,
    sourceRunRoot,
    crossAdapterReferencePath,
    verifierGitCommit,
  });

  await atomicWriteFile(resolve(outRoot, 'precision_evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  await atomicWriteFile(
    resolve(outRoot, 'repro_command.txt'),
    `npm run precision -- --symbol ${symbolArg} --date ${dateUtc} --source-run ${sourceRunArg} --out ${outArg}\n`,
  );
  await atomicWriteFile(
    resolve(outRoot, 'precision_probe.log'),
    `symbol=${symbolArg} date=${dateUtc} source_run=${sourceRunArg} git_commit=${verifierGitCommit} status=${evidence.precision_status} ticks=${evidence.observed_tick_count} multiplier=${evidence.upstream_multiplier.raw} price_digits=${evidence.candidate_price_digits} price_scale=${evidence.candidate_price_scale} bid_fail=${evidence.bid_scaled_conversion_fail_count} ask_fail=${evidence.ask_scaled_conversion_fail_count}\n`,
  );

  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.precision_status !== 'VERIFIED') process.exitCode = 2;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

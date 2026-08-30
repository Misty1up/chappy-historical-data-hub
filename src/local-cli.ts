import { LocalInstallError, importLocalDatasetPacket } from './local/installer.js';
import { LocalPacketError, scanLocalDatasetPacket } from './local/packet-verifier.js';

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (options.has(key)) throw new Error(`Duplicate option --${key}`);
    options.set(key, value);
  }
  return options;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function parseInputAndRoot(args: string[]): { input: string; root: string } {
  const options = parseOptions(args);
  const input = required(options, 'input');
  const root = required(options, 'root');
  for (const key of options.keys()) {
    if (key !== 'input' && key !== 'root') throw new Error(`Unsupported Phase 5 option --${key}`);
  }
  return { input, root };
}

export async function runLocalCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'scan' && subcommand !== 'import') {
    throw new Error('Phase 5 usage: hdh local <scan|import> --input <local-path> --root <local-hdh-root>');
  }
  const { input, root } = parseInputAndRoot(rest);

  try {
    const result = subcommand === 'scan'
      ? await scanLocalDatasetPacket(input, root)
      : await importLocalDatasetPacket(input, root);
    console.log(JSON.stringify(result, null, 2));
  } catch (cause) {
    if (cause instanceof LocalPacketError || cause instanceof LocalInstallError) {
      console.log(JSON.stringify({
        local_import_status: cause.status,
        accepted_dataset_mutation_performed: false,
        failure_code: cause.code,
        failure_detail: cause.message,
      }, null, 2));
      process.exitCode = cause.status === 'HOLD' ? 3 : 2;
      return;
    }
    throw cause;
  }
}

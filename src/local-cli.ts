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

export async function runLocalCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'scan') {
    throw new Error('Phase 5 P5.1 usage: hdh local scan --input <local-path> --root <local-hdh-root>');
  }
  const options = parseOptions(rest);
  const input = required(options, 'input');
  const root = required(options, 'root');
  for (const key of options.keys()) {
    if (key !== 'input' && key !== 'root') throw new Error(`Unsupported P5.1 option --${key}`);
  }

  try {
    const result = await scanLocalDatasetPacket(input, root);
    console.log(JSON.stringify(result, null, 2));
  } catch (cause) {
    if (!(cause instanceof LocalPacketError)) throw cause;
    console.log(JSON.stringify({
      local_import_status: cause.status,
      mutation_performed: false,
      failure_code: cause.code,
      failure_detail: cause.message,
    }, null, 2));
    process.exitCode = cause.status === 'HOLD' ? 3 : 2;
  }
}

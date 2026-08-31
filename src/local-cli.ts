import { LocalInstallError } from './local/installer.js';
import { LocalPacketError, scanLocalDatasetPacket } from './local/packet-verifier.js';
import {
  LocalRegistryError,
  adoptInstalledDataset,
  importAndRegisterLocalDatasetPacket,
  listRegisteredDatasets,
  showRegisteredDataset,
  verifyRegisteredDataset,
} from './local/registry.js';

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

function only(options: Map<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of options.keys()) {
    if (!allowedSet.has(key)) throw new Error(`Unsupported Phase 5 option --${key}`);
  }
}

function usage(): never {
  throw new Error(
    'Phase 5 usage: hdh local <scan|import|adopt|list|show|verify> '
    + '[--input <local-path>] [--dataset-id <dataset_id>] --root <local-hdh-root>',
  );
}

export async function runLocalCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || !['scan', 'import', 'adopt', 'list', 'show', 'verify'].includes(subcommand)) usage();
  const options = parseOptions(rest);
  const root = required(options, 'root');

  try {
    let result: unknown;
    switch (subcommand) {
      case 'scan': {
        only(options, ['input', 'root']);
        result = await scanLocalDatasetPacket(required(options, 'input'), root);
        break;
      }
      case 'import': {
        only(options, ['input', 'root']);
        result = await importAndRegisterLocalDatasetPacket(required(options, 'input'), root);
        break;
      }
      case 'adopt': {
        only(options, ['dataset-id', 'root']);
        result = await adoptInstalledDataset(root, required(options, 'dataset-id'));
        break;
      }
      case 'list': {
        only(options, ['root']);
        result = await listRegisteredDatasets(root);
        break;
      }
      case 'show': {
        only(options, ['dataset-id', 'root']);
        result = await showRegisteredDataset(root, required(options, 'dataset-id'));
        break;
      }
      case 'verify': {
        only(options, ['dataset-id', 'root']);
        result = await verifyRegisteredDataset(root, required(options, 'dataset-id'));
        break;
      }
      default:
        usage();
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (cause) {
    if (
      cause instanceof LocalPacketError
      || cause instanceof LocalInstallError
      || cause instanceof LocalRegistryError
    ) {
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

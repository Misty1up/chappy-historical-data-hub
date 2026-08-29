import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('Usage: node dist/scripts/verify-run.js <relative-run-path>');
const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js');
const result = spawnSync(process.execPath, [cli, 'verify', '--run', run], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

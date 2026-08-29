import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js');
const result = spawnSync(process.execPath, [cli, 'acquire', '--symbol', 'EURUSD', '--from', '2026-01-05', '--to', '2026-01-06', '--out', './runs/smoke-eurusd-1d'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

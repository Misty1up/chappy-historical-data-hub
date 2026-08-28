import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve(process.cwd(), 'dist', 'src', 'cli.js');
const oneDay = spawnSync(process.execPath, [cli, 'acquire', '--symbol', 'XAUUSD', '--from', '2026-01-05', '--to', '2026-01-06', '--out', './runs/smoke-xauusd-1d'], { stdio: 'inherit' });
if ((oneDay.status ?? 1) !== 0) process.exit(oneDay.status ?? 1);

const sevenDay = spawnSync(process.execPath, [cli, 'acquire', '--symbol', 'XAUUSD', '--from', '2026-01-05', '--to', '2026-01-12', '--out', './runs/smoke-xauusd-7d'], { stdio: 'inherit' });
process.exitCode = sevenDay.status ?? 1;

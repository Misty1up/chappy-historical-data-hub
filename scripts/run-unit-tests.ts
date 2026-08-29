import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const unitDir = resolve(process.cwd(), 'dist', 'tests', 'unit');
const files = readdirSync(unitDir)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => resolve(unitDir, name));

if (files.length === 0) throw new Error('No compiled unit test files found');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

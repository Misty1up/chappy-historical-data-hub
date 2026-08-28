import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { atomicWriteFile } from './atomic-write.js';
import { sha256File } from './hash.js';

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function appendLog(path: string, message: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await appendFile(path, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export async function buildSha256Sums(runRoot: string): Promise<string> {
  const files = (await walkFiles(runRoot))
    .filter(path => !path.endsWith('SHA256SUMS.txt') && !path.endsWith('run.log'))
    .sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const file of files) {
    const rel = relative(runRoot, file).replaceAll('\\', '/');
    lines.push(`${await sha256File(file)}  ${rel}`);
  }
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  await atomicWriteFile(resolve(runRoot, 'SHA256SUMS.txt'), text);
  return text;
}

export async function verifySha256Sums(runRoot: string): Promise<{ checked: number; mismatches: string[] }> {
  const sumsPath = resolve(runRoot, 'SHA256SUMS.txt');
  const text = await readFile(sumsPath, 'utf8');
  const mismatches: string[] = [];
  let checked = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, expected, rel] = match;
    const absolute = resolve(runRoot, rel!);
    try {
      if (!(await stat(absolute)).isFile()) throw new Error('not a file');
      const actual = await sha256File(absolute);
      checked += 1;
      if (actual !== expected) mismatches.push(rel!);
    } catch {
      mismatches.push(rel!);
    }
  }
  return { checked, mismatches };
}

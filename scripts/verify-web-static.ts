import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const out = resolve(root, 'dist-web');
const required = [
  'index.html',
  'app.js',
  'styles.css',
  'contract.js',
  'status-result.js',
  'symbol_registry.json'
];

for (const file of required) {
  const path = resolve(out, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`missing static Web artifact: ${file}`);
  }
}

const html = readFileSync(resolve(out, 'index.html'), 'utf8');
const app = readFileSync(resolve(out, 'app.js'), 'utf8');
const contract = readFileSync(resolve(out, 'contract.js'), 'utf8');
const result = readFileSync(resolve(out, 'status-result.js'), 'utf8');
const registry = readFileSync(resolve(out, 'symbol_registry.json'), 'utf8');
const combined = [html, app, contract, result, registry].join('\n');

for (const reference of ['./styles.css', './app.js']) {
  if (!html.includes(reference)) throw new Error(`index.html missing relative reference: ${reference}`);
}
for (const reference of ['./contract.js', './status-result.js', './symbol_registry.json']) {
  if (!app.includes(reference)) throw new Error(`app.js missing relative static reference: ${reference}`);
}

const forbidden = [
  /localhost:\d+/i,
  /127\.0\.0\.1:\d+/,
  /process\.env/,
  /BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/
];
for (const pattern of forbidden) {
  if (pattern.test(combined)) throw new Error(`forbidden static Web content matched: ${pattern}`);
}

if (/https?:\/\//i.test(html) || /https?:\/\//i.test(app)) {
  throw new Error('Phase 3 Web MVP must not require remote runtime assets or APIs');
}

console.log('Web static verification PASS: dist-web is self-contained and Pages-compatible.');

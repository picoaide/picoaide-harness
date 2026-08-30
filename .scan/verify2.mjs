#!/usr/bin/env node
// For each knip candidate (sym @ path), report usage scope: internal / samepkg / tests / crosspkg
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const text = readFileSync(file, 'utf8');
const pkgRoot = process.argv[3] || process.cwd().replace(/\/[^/]+$/, '');
const lines = text.split('\n');
const seen = new Set();
for (const line of lines) {
  const m = line.match(/^\s*(\S+?)\s{2,}((?:src|scripts)\/[\w\-.\\/]+):\d+:\d+\s*$/);
  if (!m) continue;
  const sym = m[1];
  const path = m[2];
  const key = sym + '@' + path;
  if (seen.has(key)) continue;
  seen.add(key);
  if (sym.includes('/') || sym.includes('.')) continue;
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = `\\b${esc}\\b`;
  const absPath = pkgRoot + '/' + path;
  let defBody = '';
  try { defBody = readFileSync(absPath, 'utf8'); } catch {}
  // internal uses: occurrences in def file minus the declaration line(s)
  const defLines = defBody.split('\n');
  const internal = defLines.filter(l => new RegExp(pat).test(l)).length;
  // repo search excluding def file
  const cmd = `grep -rnE "${pat}" ${pkgRoot} --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=dist 2>/dev/null | grep -vE '${absPath.replace(/\//g,'\\/')}' | grep -v 'deepseek-harness'`;
  let out = '';
  try { out = execSync(cmd, { encoding: 'utf8', maxBuffer: 64*1024*1024 }); } catch {}
  const rows = out.trim().split('\n').filter(Boolean);
  const files = new Set(rows.map(l => l.split(':')[0]));
  const tests = [...files].filter(f => f.includes('/tests/') || f.includes('.spec.') || f.includes('.test.'));
  const srcFiles = [...files].filter(f => !tests.includes(f));
  console.log(`${sym}\t${path}\tinternal=${internal}\tsrc=${srcFiles.length}\ttests=${tests.length}${srcFiles.length ? '\tSRC:'+srcFiles.slice(0,5).join(',') : ''}`);
}

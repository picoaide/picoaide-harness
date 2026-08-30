#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const text = readFileSync(file, 'utf8');
const lines = text.split('\n');
const seen = new Set();
for (const line of lines) {
  // knip unused-export line: SYMBOL  <spaces>  path:line:col
  const m = line.match(/^\s*(\S+?)\s{2,}((?:src|scripts|lib)\/[\w\-.\\/]+):\d+:\d+\s*$/);
  if (!m) continue;
  const sym = m[1];
  const path = m[2];
  const key = sym + '@' + path;
  if (seen.has(key)) continue;
  seen.add(key);
  if (sym.includes('/') || sym.includes('.')) continue; // skip dotted paths
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = `\\b${esc}\\b`;
  const cmd = `grep -rnE "${pat}" packages server site scripts integration-tests community docs assets --include='*.ts' --include='*.tsx' --include='*.go' --include='*.mjs' --include='*.js' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.astro' --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=dist --exclude-dir=.research --exclude-dir=.audit --exclude-dir=temp --exclude-dir=.smoke --exclude-dir=.dsh-home --exclude-dir=memory-evolve 2>/dev/null | grep -v 'deepseek-harness'`;
  let out = '';
  try { out = execSync(cmd, { encoding: 'utf8', maxBuffer: 128*1024*1024 }); } catch {}
  const rows = out.trim().split('\n').filter(Boolean);
  const files = new Set(rows.map(l => l.split(':')[0]));
  const others = [...files].filter(f => !f.endsWith(path));
  if (others.length === 0) {
    console.log(`UNUSED\t${sym}\t${path}`);
  } else {
    console.log(`used  \t${sym}\t${path}\t=> ${others.slice(0,6).join(',')}`);
  }
}

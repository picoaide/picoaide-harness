#!/usr/bin/env node
// Usage: node ref-count.mjs SYMBOL [RELPATH]
// Counts references to SYMBOL in repo (tracked code only), excluding the defining file.
import { execSync } from 'node:child_process';
const [, , sym, defFile] = process.argv;
const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pat = `\\b${esc}\\b`;
const dirs = ['packages','server','site','scripts','integration-tests','community','docs','.github','assets'];
const excl = ['node_modules','lib','dist','.research','.audit','temp','.smoke','.dsh-home','.codeql-dbs','memory-evolve'];
const cmd = `grep -rnE "${pat}" ${dirs.join(' ')} --include='*.ts' --include='*.tsx' --include='*.go' --include='*.mjs' --include='*.js' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.astro' ${excl.map(e=>`--exclude-dir=${e}`).join(' ')} | grep -v '\\\\bdeepseek-harness\\\\b'`;
try {
  const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 64*1024*1024 });
  const lines = out.trim().split('\n').filter(Boolean);
  const files = new Set();
  for (const l of lines) {
    const f = l.split(':')[0];
    if (defFile && f === defFile) continue;
    files.add(f);
  }
  console.log(`FILES=${files.size} LINES=${lines.length}`);
  if (files.size) console.log([...files].slice(0,15).join('\n'));
} catch (e) {
  console.log(`FILES=0 LINES=0`);
}

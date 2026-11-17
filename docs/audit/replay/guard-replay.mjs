#!/usr/bin/env node
// Read-only evidence: replay the run_code programs the host guard denied in
// recorded sessions through two versions of this repository's guard.
// Usage: node docs/audit/replay/guard-replay.mjs <baseline-guard.mjs>
// Produce the baseline with: git show <base>:lib/guard.js > /tmp/guard-before.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const baselinePath = process.argv[2];
if (!baselinePath) {
  console.error('usage: guard-replay.mjs <baseline-guard.mjs>');
  process.exit(2);
}
const before = await import(pathToFileURL(path.resolve(baselinePath)).href);
const after = await import(new URL('../../../lib/guard.js', import.meta.url).href);
const root = path.join(process.env.HOME, '.dsh', 'sessions');
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if (e.isDirectory()) walk(p); else if (e.name==='session.v4.jsonl.zstd') files.push(p); } })(root);
const programs = new Map();
for (const f of files) {
  let text; try { text = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8'); } catch { continue; }
  const calls = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'tool/call') { const d=o.data||{}; calls.set(d.callId, { name:d.name, args:d.arguments }); }
    else if (o.type === 'tool/result') {
      const d=o.data||{}, m=d.message||{}; const call=calls.get(m.toolCallId || d.toolCallId);
      if (call?.name !== 'run_code') continue;
      const txt = Array.isArray(m.content) ? m.content.map(c=>c?.text||'').join('\n') : '';
      if (!txt.includes('dsh-composition-guard')) continue;
      let code=''; try { code = JSON.parse(call.args).code; } catch { continue; }
      // Guard-test harnesses embed command text as data; exclude them.
      if (/commandMutatesComposition|guard-before\.mjs|lib\/guard\.js/.test(code)) continue;
      programs.set(code, true);
    }
  }
}
let deniedBefore = 0, deniedAfter = 0;
for (const code of programs.keys()) {
  if (before.codeMutatesComposition(code)) deniedBefore++;
  if (after.codeMutatesComposition(code)) deniedAfter++;
}
console.log(JSON.stringify({ uniqueHistoricalPrograms: programs.size, repoGuardDeniedBefore: deniedBefore, repoGuardDeniedAfter: deniedAfter }, null, 2));

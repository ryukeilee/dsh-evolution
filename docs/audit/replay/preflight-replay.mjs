#!/usr/bin/env node
// Read-only evidence: how many recorded run_code syntax failures the promoted
// run_code_preflight rules would have flagged before execution.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const RULES = [
  ['enum', /\benum\s+[A-Za-z_$][\w$]*\s*\{/],
  ['namespace', /\bnamespace\s+[A-Za-z_$][\w$]*\s*\{/],
  ['decorator', /(^|\n)[ \t]*@[A-Za-z_$][\w$]*/],
  ['require', /\brequire\s*\(/],
  ['dynamic-import', /(^|[^A-Za-z0-9_$.])import\s*\(/],
  ['module-syntax', /(^|\n)[ \t]*(import|export)\s/],
];
const root = path.join(process.env.HOME, '.dsh', 'sessions');
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if (e.isDirectory()) walk(p); else if (e.name==='session.v4.jsonl.zstd') files.push(p); } })(root);
let syntax = 0, flagged = 0;
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
      if (!/code run failed \(exception\): (Expected|Unexpected|Unterminated)/.test(txt)) continue;
      let code=''; try { code = JSON.parse(call.args).code; } catch { continue; }
      syntax++;
      if (RULES.some(([, re]) => re.test(code))) flagged++;
    }
  }
}
console.log(JSON.stringify({ syntaxShapedPrograms: syntax, flaggedByPromotedPreflight: flagged }, null, 2));

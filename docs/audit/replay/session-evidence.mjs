#!/usr/bin/env node
// Read-only evidence: count tool results, failure classes and promoted-tool
// usage across every DSH session log under ~/.dsh/sessions.
// Prints counts only; never prints transcript text.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.join(process.env.HOME, '.dsh', 'sessions');
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if (e.isDirectory()) walk(p); else if (e.name==='session.v4.jsonl.zstd') files.push(p); } })(root);
const promoted = { run_code_preflight: 0, run_code_diagnose: 0, readonly_git_file: 0 };
const perTool = new Map();
const rcErrors = [];
let results = 0, errors = 0;
for (const f of files) {
  let text; try { text = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8'); } catch { continue; }
  const calls = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'tool/call') { const d=o.data||{}; calls.set(d.callId, { name:d.name, args:d.arguments }); if (d.name in promoted) promoted[d.name]++; }
    else if (o.type === 'tool/result') {
      const d=o.data||{}, m=d.message||{}; const call=calls.get(m.toolCallId || d.toolCallId);
      const name = call?.name || '?'; results++;
      const row = perTool.get(name) || { total:0, errors:0 }; row.total++;
      const isErr = m.isError === true || d.error != null;
      if (isErr) { row.errors++; errors++;
        if (name === 'run_code') rcErrors.push(Array.isArray(m.content) ? m.content.map(c=>c?.text||'').join('\n') : '');
      }
      perTool.set(name, row);
    }
  }
}
function classify(t) {
  const s = t.replace(/^Error: /, '').replace(/^code run failed \(([a-z-]+)\): /, '[$1] ');
  if (s.includes('dsh-composition-guard')) return 'composition-guard';
  if (/^\[timeout\]/.test(s)) return 'timeout(120s)';
  if (/^\[invalid-output\]/.test(s)) return 'invalid-output';
  if (/Patch rejected before any change/.test(s)) return 'patch-rejected(nested)';
  if (/^\[exception\] (Expected|Unexpected|Unterminated)/.test(s)) return 'program-syntax';
  if (/^\[exception\] (TypeError|ReferenceError)/.test(s)) return 'program-runtime';
  if (/^\[exception\] ToolCallError:/.test(s)) return 'nested-tool-error';
  return 'other';
}
const classes = new Map();
for (const t of rcErrors) { const k = classify(t); classes.set(k, (classes.get(k)||0)+1); }
console.log(JSON.stringify({
  sessionLogs: files.length,
  toolResults: results,
  errors,
  promotedInvocations: promoted,
  runCodeErrors: rcErrors.length,
  runCodeErrorClasses: Object.fromEntries([...classes].sort((a,b)=>b[1]-a[1])),
  topTools: [...perTool].sort((a,b)=>b[1].errors-a[1].errors).slice(0,10).map(([name, r]) => ({ name, ...r })),
}, null, 2));

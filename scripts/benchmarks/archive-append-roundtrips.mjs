#!/usr/bin/env node
// Real official-storage benchmark; no source rewrite, stack capture, or per-call logging.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '../..');
const KEY = 'b'.repeat(64); // synthetic fixture only
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(`--${key}`); return i < 0 ? fallback : args[i + 1]; };
const positive = value => { const n = Number(value); assert.ok(Number.isSafeInteger(n) && n > 0); return n; };
const sha = data => createHash('sha256').update(data).digest('hex');
function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en')).flatMap(e => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? files(root, rel) : e.isFile() ? [rel] : [];
  });
}
function identity(root) {
  return sha(files(path.join(root, 'lib')).map(rel => `${rel}\0${sha(fs.readFileSync(path.join(root, 'lib', rel)))}\n`).join(''));
}
function digest(root) {
  const entries = files(root).map(rel => { const raw = fs.readFileSync(path.join(root, rel)); return { path: rel, bytes: raw.length, sha256: sha(raw) }; });
  return { sha256: sha(JSON.stringify(entries)), bytes: entries.reduce((n,e) => n + e.bytes, 0), files: entries };
}
function counters(enabled) {
  const rows = {}, restore = [], fdPaths = new Map();
  const group = value => {
    const p = typeof value === 'number' ? fdPaths.get(value) : String(value ?? '');
    if (!p) return 'other';
    if (p.includes('archive-index')) return 'archive-index';
    if (p.includes('-archive.jsonl')) return 'archive-data';
    if (p.includes('execution-events.jsonl')) return 'event-log';
    return 'other';
  };
  // Fixed counters and two timestamps per call; no stack and no payload inspection.
  function wrap(target, name, async = false) {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function(...a) {
      const key = `${async ? 'promises.' : ''}${name}:${group(a[0])}`;
      const row = rows[key] ??= { calls: 0, elapsedMs: 0 };
      const start = performance.now();
      const done = () => { row.calls++; row.elapsedMs += performance.now() - start; };
      if (async) {
        try {
          let pending = original.apply(this,a);
          if (name === 'open') pending = pending.then(handle => {
            const category = group(a[0]);
            for (const method of ['stat','read','close','sync','writeFile','write']) {
              const fn = handle[method];
              if (typeof fn !== 'function') continue;
              handle[method] = function(...params) {
                const item = rows[`handle.${method}:${category}`] ??= { calls: 0, elapsedMs: 0 };
                const t = performance.now();
                return fn.apply(this,params).finally(() => { item.calls++; item.elapsedMs += performance.now()-t; });
              };
            }
            return handle;
          });
          return pending.finally(done);
        } catch (e) { done(); throw e; }
      }
      try {
        const result = original.apply(this,a);
        if (name === 'openSync') fdPaths.set(result, String(a[0]));
        if (name === 'closeSync') fdPaths.delete(a[0]);
        return result;
      } finally { done(); }
    };
    restore.push(() => { target[name] = original; });
  }
  if (enabled) {
    for (const name of ['accessSync','appendFileSync','closeSync','copyFileSync','existsSync','fstatSync','fsyncSync','linkSync','lstatSync','mkdirSync','openSync','readSync','readFileSync','readdirSync','renameSync','rmSync','statSync','truncateSync','unlinkSync','writeSync','writeFileSync']) wrap(fs,name);
    for (const name of ['appendFile','copyFile','mkdir','open','readFile','readdir','rename','rm','stat','unlink','writeFile']) wrap(fsp,name,true);
    syncBuiltinESMExports();
  }
  return { rows, stop() { restore.reverse().forEach(fn => fn()); syncBuiltinESMExports(); } };
}
function event(sequence) {
  const experimentId = `append-bench-${String(sequence).padStart(8,'0')}`;
  return { schema: 1, eventId: `evolution:measurement-completed:${experimentId}`, eventType: 'measurement-completed', experimentId,
    proposalId: `proposal-${experimentId}`, target: 'plugin:append-bench', capability: 'plugin:append-bench', lineageId: 'plugin:append-bench', status: 'measured',
    measurement: { latency: 10 + sequence % 101, throughput: 20 + sequence % 53 }, evidence: { testPassed: true },
    audit: { producer: 'dsh-evolution-orchestrator', at: '2026-10-29T00:00:00.000Z' } };
}
async function worker() {
  if (args.includes('--validate-worker')) {
    // Deterministic audit clock only for equivalence fixtures. Date.now stays
    // real, so lock elapsed-time/ownership protocols retain their real clock.
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...values) { super(...(values.length ? values : ['2026-10-29T00:00:00.000Z'])); }
    };
  }
  const root = path.resolve(opt('root', REPO));
  const records = positive(opt('records',2000)), delta = positive(opt('delta',2000));
  const scenario = opt('scenario','cold');
  const req = createRequire(path.join(root,'package.json'));
  const [{ openDomainStorage }, { signEventBridgeEnvelope }, { DomainFacility }, { JsonStorageBackend }] = await Promise.all([
    import(pathToFileURL(path.join(root,'lib/domain-storage.js'))), import(pathToFileURL(path.join(root,'lib/orchestrator.js'))),
    import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-domain'))), import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-json')))
  ]);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'archive-append-roundtrips-'));
  const log = path.join(temp,'execution-events.jsonl');
  const backend = new JsonStorageBackend(path.join(temp,'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx,{ backend:'json' });
  const config = { presetDir:temp,eventBridgePath:log,eventBridgeKey:KEY };
  let port;
  const append = (start,end) => {
    const lines = [];
    for(let i=start;i<=end;i++) lines.push(JSON.stringify(signEventBridgeEnvelope(event(i),{key:KEY,sequence:i})));
    fs.appendFileSync(log,`${lines.join('\n')}\n`,{ mode:0o600 });
  };
  try {
    append(1,records);
    if(scenario === 'incremental') {
      port = await openDomainStorage(ctx,config); await port.close(); port = null;
      assert.ok(files(path.join(temp,'dockyard')).some(p => p.includes('-archive.jsonl')), 'seed must contain real archives');
      append(records+1,records+delta);
    }
    const fixture = digest(temp);
    const trace = counters(opt('instrument','yes') !== 'no');
    const cpu = process.cpuUsage(), start = performance.now(), rssBefore = process.memoryUsage().rss;
    try { port = await openDomainStorage(ctx,config); }
    finally { trace.stop(); }
    const wallMs = performance.now()-start, used=process.cpuUsage(cpu);
    const rssAfter = process.memoryUsage().rss, maxRssBytes = process.resourceUsage().maxRSS * 1024;
    const durable = JSON.parse(fs.readFileSync(path.join(temp,'official/evolution_domain.json'),'utf8')).global;
    const expected = records + (scenario === 'incremental' ? delta : 0);
    assert.equal(Object.keys(durable.applied).length,expected); assert.equal(durable.pending,null);
    const final = digest(temp);
    const archive = digest(path.join(temp,'dockyard'));
    const sample = { scenario, records, delta:scenario === 'incremental' ? delta : 0, absorbed:scenario === 'incremental' ? delta : records,
      wallMs,cpuMs:(used.user+used.system)/1000,rssBefore,rssAfter,maxRssBytes,fs:trace.rows,fixture,final,archive,
      applied:expected, pending:null };
    if (args.includes('--validate-worker')) {
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b,'en')).map(([key,item]) => [key,canonical(item)])) : value;
      const stateSnapshot = () => {
        const state = JSON.parse(fs.readFileSync(path.join(temp,'official/evolution_domain.json'),'utf8')).global;
        assert.equal(state.pending,null);
        assert.equal(Object.keys(state.applied).length,expected);
        for (const meta of Object.values(state.aggregate.evolution.coldArchives ?? {})) {
          for (const key of ['file','activeFile','indexFile','segments']) {
            if (!(key in meta)) continue;
            const normalizePath = value => {
              assert.equal(typeof value,'string');
              const at = value.lastIndexOf('/state.json.');
              assert.ok(at >= 0, `unexpected archive metadata path: ${value}`);
              return `<archive-root>/${value.slice(at+1)}`;
            };
            meta[key] = Array.isArray(meta[key]) ? meta[key].map(normalizePath) : normalizePath(meta[key]);
          }
        }
        const index = JSON.parse(fs.readFileSync(path.join(temp,'dockyard/state.json.evolution-archive-index.json'),'utf8'));
        const normalizeTime = object => {
          if (!Object.hasOwn(object,'updatedAt')) return;
          assert.match(object.updatedAt,/^\d{4}-\d\d-\d\dT/);
          object.updatedAt = '<index-write-clock>';
        };
        normalizeTime(index); for (const entry of index.segments) normalizeTime(entry);
        const archiveFiles = digest(path.join(temp,'dockyard')).files.filter(e=>e.path.endsWith('.jsonl'));
        const query = port.query('experiments',100);
        assert.equal(query.count,expected);
        return { stateSha256:sha(JSON.stringify(canonical(state))), ledgerSha256:sha(JSON.stringify(canonical(state.applied))),
          markerSha256:sha(JSON.stringify(canonical(state.aggregate.evolution.eventBridge))),
          markerCount:state.aggregate.evolution.eventBridge.applied.length,
          querySha256:sha(JSON.stringify(canonical(query))), indexNormalizedSha256:sha(JSON.stringify(canonical(index))),
          jsonlSha256:sha(JSON.stringify(archiveFiles)), archiveFiles };
      };
      const stages=[stateSnapshot()], flush=[];
      flush.push(await port.flush()); assert.equal(flush.at(-1).applied,0); stages.push(stateSnapshot());
      for(let restart=0;restart<2;restart++) {
        await port.close(); port=null; port=await openDomainStorage(ctx,config);
        flush.push(await port.flush()); assert.equal(flush.at(-1).applied,0); stages.push(stateSnapshot());
      }
      for(const stage of stages.slice(1)) assert.deepEqual(stage,stages[0],'flush/restart changed durable state or archive bytes');
      sample.validation={flush,stages};
    }
    await port.close(); port=null;
    console.log(JSON.stringify(sample));
  } finally { if(port) await port.close(); await backend.close(); fs.rmSync(temp,{recursive:true,force:true}); }
}
async function validate() {
  const roots={A:path.resolve(opt('a-root',REPO)),B:path.resolve(opt('b-root',REPO))};
  const counts=String(opt('records','2000,12000,20000')).split(',').map(positive);
  const source={A:identity(roots.A),B:identity(roots.B)},samples=[];
  const out=path.resolve(opt('out',path.join(REPO,'docs/performance/archive-append-roundtrips-equivalence.json')));
  assert.ok(!fs.existsSync(out));
  const ledger=out.replace(/\.json$/u,'')+'.samples.jsonl';
  fs.writeFileSync(ledger,'',{flag:'wx'});
  for(const scenario of ['cold','incremental']) for(const records of counts) {
    const pair=[];
    for(const side of ['A','B']) {
      const child=spawnSync(process.execPath,['--max-old-space-size=4096',SELF,'--worker','--validate-worker','--root',roots[side],
        '--records',String(records),'--scenario',scenario,'--delta',String(positive(opt('delta',2000)))],
        {encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--max-old-space-size=4096'},maxBuffer:16*1024*1024});
      assert.equal(child.status,0,child.stderr||child.stdout);
      const row={side,scenario,records,sample:JSON.parse(child.stdout)}; samples.push(row);pair.push(row); fs.appendFileSync(ledger,JSON.stringify(row)+'\n');
      console.error(`validate ${scenario} ${records} ${side} passed`);
    }
    assert.deepEqual(pair[0].sample.validation,pair[1].sample.validation,'A/B state/marker/flush/restart/archive equivalence failed');
  }
  assert.equal(identity(roots.A),source.A); assert.equal(identity(roots.B),source.B);
  fs.writeFileSync(out,JSON.stringify({schema:1,node:process.version,source,roots,counts,method:'Same deterministic signed fixture with fixed zero-argument new Date audit clock; Date.now remains real. All state keys retained; only coldArchives file/activeFile/indexFile/segments root prefixes canonicalized. Index only top-level and segment updatedAt clocks canonicalized; all other fields retained. JSONL bytes compared via SHA256 and size. Each side checks flush followed by two close/reopens and flushes.',samples},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({out,passed:true,samples:samples.length}));
}
function median(values) { const s=[...values].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
async function runner() {
  const roots={ A:path.resolve(opt('a-root',REPO)), B:path.resolve(opt('b-root',opt('a-root',REPO))) };
  const rounds=positive(opt('rounds',3)); assert.ok(rounds>=3,'at least 3 rounds');
  const counts=String(opt('records','2000,12000,20000')).split(',').map(positive);
  const phases=String(opt('phases','aa')).split(','); assert.ok(phases.every(p=>['aa','ab','overhead'].includes(p)));
  const out=path.resolve(opt('out',path.join(REPO,'docs/performance/archive-append-roundtrips-baseline.json')));
  assert.ok(!fs.existsSync(out),`output already exists: ${out}`);
  const ledger=out.replace(/\.json$/u,'')+'.samples.jsonl'; assert.ok(!fs.existsSync(ledger));
  const source={ A:identity(roots.A), B:identity(roots.B) }, samples=[];
  fs.writeFileSync(ledger,'',{flag:'wx'});
  for(const phase of phases) for(const scenario of ['cold','incremental']) for(const records of counts) for(let round=1;round<=rounds;round++) {
    const order=round%2 ? ['A','B'] : ['B','A'];
    for(const side of order) {
      const root=phase==='ab' ? roots[side] : roots.A;
      const instrument=phase==='overhead' ? (side==='A' ? 'no':'yes') : opt('instrument','yes');
      assert.ok(['yes','no'].includes(instrument),'--instrument must be yes or no');
      const result=spawnSync(process.execPath,['--max-old-space-size=4096',SELF,'--worker','--root',root,'--records',String(records),'--delta',String(positive(opt('delta',2000))),'--scenario',scenario,'--instrument',instrument],
        { encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--max-old-space-size=4096'},maxBuffer:16*1024*1024 });
      assert.equal(result.status,0,`worker failed: ${result.stderr || result.error || result.stdout}`);
      const row={phase,scenario,records,round,side,instrument,sample:JSON.parse(result.stdout)};
      samples.push(row); fs.appendFileSync(ledger,JSON.stringify(row)+'\n');
      console.error(`${phase} ${scenario} ${records} round=${round} ${side}: ${row.sample.wallMs.toFixed(1)}ms`);
    }
  }
  assert.equal(identity(roots.A),source.A,'A changed during run'); assert.equal(identity(roots.B),source.B,'B changed during run');
  const summary=[];
  for(const phase of phases) for(const scenario of ['cold','incremental']) for(const records of counts) {
    const rows=samples.filter(r=>r.phase===phase && r.scenario===scenario && r.records===records);
    summary.push({ phase,scenario,records,sides:Object.fromEntries(['A','B'].map(side=>{
      const ss=rows.filter(r=>r.side===side).map(r=>r.sample);
      return [side,{...Object.fromEntries(['wallMs','cpuMs','maxRssBytes'].map(k=>[k,median(ss.map(s=>s[k]))])),
        fs: Object.fromEntries(Object.keys(ss[0].fs).map(k=>[k,{calls:median(ss.map(s=>s.fs[k]?.calls??0)),elapsedMs:median(ss.map(s=>s.fs[k]?.elapsedMs??0))}]))}];
    })), pairs:Array.from({length:rounds},(_,i)=>{
      const a=rows.find(r=>r.round===i+1 && r.side==='A').sample,b=rows.find(r=>r.round===i+1 && r.side==='B').sample;
      return {round:i+1,wallDeltaMs:b.wallMs-a.wallMs,cpuDeltaMs:b.cpuMs-a.cpuMs,archiveByteDigestEqual:a.archive.sha256===b.archive.sha256};
    }) });
  }
  const report={schema:1,node:process.version,platform:`${process.platform}/${process.arch}`,roots,source,rounds,counts,phases,
    method:'Fresh process/temp home per sample; official DomainFacility + JsonStorageBackend + real openDomainStorage. Cold replay from no checkpoint; incremental reopens after seeding N real events then appending delta. fs wrappers only during measured open. JS fs API calls, not kernel syscalls; nested API elapsed times must not be summed. Async open FileHandle stat/read/close/sync/write/writeFile are included. maxRSS is process lifetime high-water including seed. Final byte digests before close; dynamic timestamp/path metadata can differ. A/A = identical root with alternating labels; overhead = unwrapped A vs wrapped B; A/B = roots selected explicitly.',
    instrument:opt('instrument','yes'),summary,samples};
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({out,ledger,summary},null,2));
}
assert.match(`${process.execArgv.join(' ')} ${process.env.NODE_OPTIONS??''}`,/--max-old-space-size(?:=|\s)4096(?:\s|$)/,'4096 MiB heap limit required');
if(args.includes('--help')) console.log('Usage: node --max-old-space-size=4096 scripts/benchmarks/archive-append-roundtrips.mjs [--validate] [--instrument yes|no] [--records 2000,12000,20000] [--rounds 3] [--delta 2000] [--phases aa,ab,overhead] [--a-root .] [--b-root /tmp/candidate] [--out docs/performance/archive-append-roundtrips-NAME.json]');
else if(args.includes('--worker')) await worker(); else if(args.includes('--validate')) await validate(); else await runner();

// Isolated, rotating A/A/B measurement using the committed official-backend fixture.
// Never modifies lib/ or reads an existing data root. Candidate is scratch-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const replace = (source, from, to) => { assert.equal(source.split(from).length, 2, from); return source.replace(from, to); };
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
if (args.includes('--child')) {
  const fixture = await import(pathToFileURL(opt('fixture')).href);
  const directory = opt('lib');
  const history = Number(opt('history'));
  const newEvents = Number(opt('new', 0));
  const samples = Number(opt('samples', 30));
  const mode = opt('mode', 'clean');
  if (mode === 'attribution') {
    console.log(JSON.stringify(await fixture.runAttribution(directory, { history }, samples)));
  } else if (mode === 'behaviors') {
    const outcomes = [];
    for (const name of ['tampered-prefix', 'checkpoint-deleted', 'marker-rewound-replaced', 'marker-rewound-in-place', 'torn-trailing-record', 'restart']) {
      outcomes.push({ name, result: await fixture.runBehavior(directory, name, { history }) });
    }
    console.log(JSON.stringify(outcomes));
  } else {
    const run = await fixture.runScenario(directory, { history, newEvents }, { clockMode: 'advance', trace: mode === 'trace', samples });
    assert.deepEqual(run.restart, { applied: 0, duplicates: history + newEvents * (3 + samples) });
    assert.equal(run.stagingLeft, 0);
    assert.equal(run.restartDocumentUnchanged, true);
    assert.equal(run.restartCheckpointUnchanged, true);
    const sums = key => run.rows.reduce((sum,row) => sum+row[key], 0);
    const windows = [];
    for (let i = 0; i < samples; i += Math.max(1, Math.ceil(samples / 10))) {
      const rows = run.rows.slice(i, i+Math.max(1,Math.ceil(samples/10)));
      windows.push({ from: i, count: rows.length, wallMs: median(rows.map(x=>x.wallMs)), cpuMs: median(rows.map(x=>x.cpuMs)), memory: rows.at(-1).memory });
    }
    console.log(JSON.stringify({ rows: run.rows, wallMs: median(run.rows.map(x=>x.wallMs)), cpuMs: median(run.rows.map(x=>x.cpuMs)), cumulativeWallMs: sums('wallMs'), cumulativeCpuMs: sums('cpuMs'), windows,
      memoryBefore: run.memoryBefore, memoryAfter: run.memoryAfter, measuredMaxRSS: run.measuredMaxRSS,
      processMaxRSS: process.resourceUsage().maxRSS, io: run.traced, buffers: run.buffers,
      durable: { document: hash(run.durable.document), checkpoint: run.durable.checkpoint, archives: run.durable.archives },
      documentBytes: run.documentBytes, logBytes: run.logBytes }));
  }
} else {
  const revision = opt('baseline', 'c2c8d2e2d8abf986ee14b360a842a72f999ddae7');
  const rounds = Number(opt('rounds', 5));
  const samples = Number(opt('samples', 40));
  const histories = opt('histories', '200,2000,20000').split(',').map(Number);
  const events = opt('events', '0,1').split(',').map(Number);
  const continuous = Number(opt('continuous', 0));
  for (const n of [rounds,samples,...histories]) assert.ok(Number.isSafeInteger(n) && n>0);
  for (const n of [...events,continuous]) assert.ok(Number.isSafeInteger(n) && n>=0);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-read-buffer-'));
  const git = (...cmd) => execFileSync('git', cmd, { cwd: repo, maxBuffer: 20*1024*1024 });
  const report = { revision: git('rev-parse', revision).toString().trim(), environment: { node:process.version, platform:`${process.platform}/${process.arch}`, loadAtStart:os.loadavg() },
    rounds, samples, histories, events, continuous, protocol: 'A1/A2 identical baseline, B 64 KiB temporary chunk. Each cell rotates A1/A2/B. Independent process and temp root. Clean timing separate from traced I/O. Clock advances 1ms/read; timing is actual performance.now. GC before/after only. Memory every flush outside latency timer. Long run uses same port without resets. Synthetic authenticated history seeds a complete ledger and empty aggregate; new events grow real aggregate and archives.', rows:[], trace:[], attribution:[], behaviors:[] };
  try {
    const baseline = path.join(scratch,'baseline');
    fs.mkdirSync(baseline);
    execFileSync('tar', ['-x','-C',baseline], { input:git('archive',revision,'lib') });
    fs.symlinkSync(path.join(repo,'node_modules'), path.join(baseline,'node_modules'));
    fs.writeFileSync(path.join(baseline,'package.json'), '{"type":"module"}');
    const candidate = path.join(scratch,'candidate');
    fs.cpSync(baseline,candidate,{recursive:true});
    const file = path.join(candidate,'lib/event-log-checkpoint.js');
    fs.writeFileSync(file,replace(fs.readFileSync(file,'utf8'),'const READ_CHUNK_BYTES = 1 << 20;','const READ_CHUNK_BYTES = 1 << 16;'));
    report.sourceSHA256 = Object.fromEntries([['baseline',baseline],['candidate',candidate]].map(([name,dir])=>[name,hash(fs.readFileSync(path.join(dir,'lib/event-log-checkpoint.js')))]));
    // Use only committed fixture bytes; unrelated working-tree experiments cannot affect results.
    let fixture = git('show',`${revision}:scripts/benchmarks/domain-flush-steady-cost.mjs`).toString();
    report.fixtureOriginalSHA256 = hash(fixture);
    fixture = replace(fixture, 'const SOURCE_FILES = ["lib/event-log-checkpoint.js", "lib/domain-storage.js"];', 'const SOURCE_FILES = ["lib/event-log-checkpoint.js"];');
    fixture = replace(fixture, 'await report();', 'export { runScenario, runAttribution, runBehavior };');
    fixture = replace(fixture, 'const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));', 'const REPO_ROOT = process.env.FLUSH_BENCH_ROOT;');
    fixture = replace(fixture, '    if (counter) counter.reset();\n    for (let index', `    global.gc();\n    const memoryBefore = process.memoryUsage();\n    let measuredMaxRSS = memoryBefore.rss;\n    const originalAlloc = Buffer.allocUnsafe;\n    const buffers = { calls: 0, bytes: 0 };\n    if (counter) Buffer.allocUnsafe = function(size) { buffers.calls++; buffers.bytes += size; return originalAlloc(size); };\n    if (counter) counter.reset();\n    for (let index`);
    fixture = replace(fixture, '      rows.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });', '      const memory = process.memoryUsage();\n      measuredMaxRSS = Math.max(measuredMaxRSS, memory.rss);\n      rows.push({ wallMs, cpuMs: (used.user + used.system) / 1000, memory });');
    fixture = replace(fixture, '    const traced = counter ? counter.read() : null;', '    if (counter) Buffer.allocUnsafe = originalAlloc;\n    const traced = counter ? counter.read() : null;\n    global.gc();\n    const memoryAfter = process.memoryUsage();');
    fixture = replace(fixture, 'return { rows, traced, durable, stagingLeft, restart,', 'return { rows, traced, durable, stagingLeft, restart, memoryBefore, memoryAfter, measuredMaxRSS, buffers,');
    // Bring historical attribution anchors forward to the current retention-aware calls.
    fixture = fixture.replaceAll('if (checkpoint.appliedDigest !== digestApplied(applied)) return false;', 'if (checkpoint.appliedDigest !== digestApplied(applied, retention)) return false;')
      .replaceAll("() => digestApplied(applied))) return false;", "() => digestApplied(applied, retention))) return false;");
    // Only checkpoint phases are needed; do not patch the changed domain call site.
    fixture = fixture.replace(/  \["lib\/domain-storage\.js",\n    "const plan = planEventLogReplay[\s\S]*?\],\n\];/, '\n];');
    const fixturePath = path.join(scratch,'fixture.mjs');
    fs.symlinkSync(path.join(repo,'node_modules'),path.join(scratch,'node_modules'));
    fs.writeFileSync(fixturePath,fixture);
    report.fixtureMaterializedSHA256 = hash(fixture);
    const run = (side, history, newEvents, count, mode='clean') => JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=4096','--expose-gc',self,'--child','--fixture',fixturePath,'--lib',side==='B'?candidate:baseline,'--history',String(history),'--new',String(newEvents),'--samples',String(count),'--mode',mode], {cwd:repo,env:{...process.env,FLUSH_BENCH_ROOT:side==='B'?candidate:baseline},encoding:'utf8',maxBuffer:40*1024*1024}));
    const save = () => { report.environment.loadAtEnd=os.loadavg(); if(opt('out')) fs.writeFileSync(opt('out'),JSON.stringify(report,null,2)+'\n'); };
    for (const history of histories) for(const newEvents of events) for(let round=0;round<rounds;round++) {
      const order=['A1','A2','B'].map((_,i)=>['A1','A2','B'][(i+round)%3]);
      for(const side of order) {
        const result=run(side,history,newEvents,samples);
        const peers=report.rows.filter(x=>!x.continuous && x.history===history && x.newEvents===newEvents);
        if(peers.length) assert.deepEqual(result.durable,peers[0].durable);
        report.rows.push({history,newEvents,round,side,order,...result}); save();
        console.error(JSON.stringify({history,newEvents,round,side,wallMs:result.wallMs,cpuMs:result.cpuMs}));
      }
    }
    for(const history of histories) for(const newEvents of events) for(const side of ['A1','B']) {
      report.trace.push({history,newEvents,side,...run(side,history,newEvents,3,'trace')}); save();
    }
    for(const history of histories) for(const side of ['A1','B']) {
      report.attribution.push({history,side,phases:run(side,history,0,20,'attribution')}); save();
    }
    for(const side of ['A1','B']) {report.behaviors.push({side,outcomes:run(side,200,0,1,'behaviors')}); save();}
    assert.deepEqual(report.behaviors[0].outcomes,report.behaviors[1].outcomes);
    if(continuous) for(let round=0;round<3;round++) for(const newEvents of [0,1]) {
      const order=['A1','A2','B'].map((_,i)=>['A1','A2','B'][(i+round)%3]);
      for(const side of order) {const result=run(side,2000,newEvents,continuous);report.rows.push({continuous:true,history:2000,newEvents,round,side,order,...result});save();console.error(JSON.stringify({continuous:true,newEvents,round,side,wallMs:result.wallMs,cpuMs:result.cpuMs}));}
    }
    if (continuous) for (const newEvents of [0,1]) {
      const peers = report.rows.filter(row => row.continuous && row.newEvents === newEvents);
      assert.equal(peers.length, 9);
      for (const row of peers) assert.deepEqual(row.durable, peers[0].durable);
      if (newEvents && continuous > 300) assert.ok(peers[0].durable.archives.length > 0);
    }
    save();
    console.log(JSON.stringify({out:opt('out'),rows:report.rows.length,sourceSHA256:report.sourceSHA256}));
  } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}

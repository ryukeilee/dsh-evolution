// Read-only production investigation. All mutable fixtures live in /tmp.
// node --max-old-space-size=4096 scripts/benchmarks/axis-steady-history.mjs --out docs/performance/axis-steady-history.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => args.includes('--'+k) ? args[args.indexOf('--'+k)+1] : d;
const median = xs => { const sorted=[...xs].sort((a,b)=>a-b), mid=Math.floor(sorted.length/2); return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2; };
const key = 'b'.repeat(64);
const histories = [200, 2000, 20000, 50000, 100000];
const rounds = 3, samples = 15, warmup = 3;
if (!args.includes('--child')) {
  const result = { environment: { node:process.version, platform:process.platform, arch:process.arch,
    cpus:os.cpus().length, loadStart:os.loadavg(), commit:spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim() },
    protocol:{rounds,samples,warmup, order:'round 0/2 A,B; round 1 B,A; fresh child/fixture per side, identical sources',
      curve:'signed measurement events, precommitted ledger, empty aggregate (same isolation as previous benchmark)',
      reclaim:'20000 events, one experiment, real durable official evidence sidecar; archives:false isolates log reclaim'}, sources:{}, rows:[] };
  for(const name of ['lib/domain-storage.js','lib/event-log-checkpoint.js','lib/orchestrator.js']) result.sources[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,name))).digest('hex');
  const jobs = [...histories.map(n=>({n,retain:null})), ...[0,200,2000,5000].map(retain=>({n:20000,retain}))];
  for (let round=0; round<rounds;round++) for(const job of jobs) for(const side of (round%2 ? ['B','A']:['A','B'])) {
    process.stderr.write(`round ${round+1} ${side} ${JSON.stringify(job)}\n`);
    const run=spawnSync(process.execPath,['--max-old-space-size=4096',fileURLToPath(import.meta.url),'--child','--n',String(job.n),'--retain',String(job.retain)],{cwd:repo,encoding:'utf8',timeout:300000,maxBuffer:4*1024*1024});
    assert.equal(run.status,0,run.stderr || run.error?.message);
    result.rows.push({round,side,...JSON.parse(run.stdout)});
  }
  result.environment.loadEnd=os.loadavg();
  result.summary=jobs.map(job=>{
    const rows=result.rows.filter(r=>r.n===job.n&&r.retain===job.retain);
    const wall=median(rows.map(r=>r.after.wallMs)), cpu=median(rows.map(r=>r.after.cpuMs));
    const base=job.retain===null?wall:median(rows.map(r=>r.before.wallMs));
    const cost=job.retain===null?null:median(rows.map(r=>r.reclaim.wallMs));
    return {...job,wallMs:wall,cpuMs:cpu,roundWallMs:rows.map(r=>r.after.wallMs),logBytes:rows[0].logBytes,
      markers:rows[0].markers,markerJsonBytes:rows[0].markerJsonBytes,bytesPerMarker:rows[0].markerJsonBytes/Math.max(1,rows[0].markers),
      session200Ms:200*wall,baseWallMs:base,reclaimWallMs:cost,breakEvenSteps:cost===null?null:Math.ceil(cost/(base-wall)),
      breakEvenWithFinalFlushSteps:cost===null?null:Math.ceil((cost+wall)/(base-wall)),
      wallRangeMs:[Math.min(...rows.map(r=>r.after.wallMs)),Math.max(...rows.map(r=>r.after.wallMs))]};
  });
  if(opt('out',null)) fs.writeFileSync(opt('out'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result.summary,null,2));
} else {
  const n=Number(opt('n')), retain=opt('retain')==='null'?null:Number(opt('retain'));
  const root=fs.mkdtempSync('/tmp/axis-steady-');
  const {evolutionDomainSpec,openDomainStorage}=await import('../../lib/domain-storage.js');
  const {signEventBridgeEnvelope,externalizeEventBridgeEvidence}=await import('../../lib/orchestrator.js');
  const {MIN_LOG_RETAIN_RECORDS,MAX_LOG_RETAIN_RECORDS,DEFAULT_LOG_RETAIN_RECORDS}=await import('../../lib/event-log-checkpoint.js');
  const effectiveRetain=retain===null?n:Math.max(MIN_LOG_RETAIN_RECORDS,Math.min(MAX_LOG_RETAIN_RECORDS,Math.trunc(Number(retain)||DEFAULT_LOG_RETAIN_RECORDS)));
  const {DomainFacility}=await import('@deepseek-ai/dsh-storage-domain');
  const {JsonStorageBackend}=await import('@deepseek-ai/dsh-storage-json');
  const log=path.join(root,'execution-events.jsonl'), archiveDir=path.join(root,'archive');
  const applied={}, lines=[];
  for(let i=1;i<=n;i++) {
    const event={schema:1,eventId:`evolution:measurement-completed:steady-experiment-${i}`,eventType:'measurement-completed',
      experimentId:retain===null?`steady-experiment-${i}`:'steady-experiment-shared',proposalId:`steady-proposal-${i}`,
      target:'plugin:steady',capability:'plugin:steady',lineageId:'plugin:steady',status:'measured',
      measurement:{latency:12,throughput:100},evidence:{summary:'Synthetic measured evolution event'},canary:{},
      audit:{producer:'dsh-evolution-orchestrator',at:'2026-10-07T00:00:00.000Z'}};
    const envelope=signEventBridgeEnvelope(event,{key,sequence:i});
    applied[event.eventId]=envelope.mac; lines.push(JSON.stringify(envelope));
  }
  fs.writeFileSync(log,lines.join('\n')+'\n');
  const backend=new JsonStorageBackend(path.join(root,'official'));
  const ctx={emit(){},on(){return ()=>{}},logger:{warn(){},error(){}},storage:{backend:{get:()=>backend}},effect(){}};
  ctx.storageDomain=new DomainFacility(ctx,{backend:'json'});
  let domain=await ctx.storageDomain.open(evolutionDomainSpec);
  await domain.global.set({schema:1,aggregate:{},applied,pending:null}); await domain.close();
  const port=await openDomainStorage(ctx,{presetDir:root,archiveDir,eventBridgePath:log,eventBridgeKey:key,
    externalizeEventEvidence:entries=>externalizeEventBridgeEvidence({archiveDir},entries)});
  domain=ctx.storageDomain.get('evolution_domain');
  const timed=async fn=>{const cpu=process.cpuUsage(), start=performance.now();const value=await fn();const wallMs=performance.now()-start, used=process.cpuUsage(cpu);return {wallMs,cpuMs:(used.user+used.system)/1000,value}};
  async function measure(){for(let i=0;i<warmup;i++)await port.flush();const rows=[];for(let i=0;i<samples;i++)rows.push(await timed(()=>port.flush()));return {wallMs:median(rows.map(r=>r.wallMs)),cpuMs:median(rows.map(r=>r.cpuMs)),rows};}
  const first=await port.flush();assert.deepEqual(first,{applied:0,duplicates:n});
  const before=await measure();
  let reclaim=null,after=before;
  if(retain!==null){reclaim=await timed(()=>port.reclaim({confirmation:true,archives:false,retainRecords:retain}));assert.equal(reclaim.value.log.status,'discarded'); after=await measure();}
  // Accounting in a separate, untimed pass. Includes sync fs, promises fs,
  // backend FileHandle writes/sync, domain.set, and keyed/hash input bytes.
  const originals=[], counts={};let bytesRead=0,hashedBytes=0;
  const bump=k=>counts[k]=(counts[k]??0)+1;
  for(const method of ['openSync','readSync','readFileSync','writeSync','writeFileSync','appendFileSync','renameSync','fsyncSync','mkdirSync','rmSync','unlinkSync']) {
    const orig=fs[method]; originals.push(()=>fs[method]=orig);
    fs[method]=function(...a){bump(method);const out=orig.apply(this,a);if(method==='readSync')bytesRead+=out;return out;};
  }
  for(const method of ['open','writeFile','appendFile','rename','mkdir','rm','unlink']){
    const orig=fs.promises[method]; originals.push(()=>fs.promises[method]=orig);
    fs.promises[method]=async function(...a){bump('async.'+method);const out=await orig.apply(this,a);if(method==='open')for(const k of ['write','writeFile','sync','datasync']){const old=out[k].bind(out);out[k]=(...b)=>{bump('handle.'+k);return old(...b)}}return out;};
  }
  const set=domain.global.set;domain.global.set=function(...a){bump('domain.set');return set.apply(this,a)};originals.push(()=>domain.global.set=set);
  for(const method of ['createHash','createHmac']){const orig=crypto[method];originals.push(()=>crypto[method]=orig);crypto[method]=function(...a){const inner=orig.apply(this,a);const wrap=h=>({update(data,...rest){hashedBytes+=typeof data==='string'?Buffer.byteLength(data):data.byteLength;h.update(data,...rest);return this},digest(...b){return h.digest(...b)},copy(...b){return wrap(h.copy(...b))}});return wrap(inner)}}
  syncBuiltinESMExports();
  const accountingResult=await port.flush();
  for(const restore of originals.reverse())restore();syncBuiltinESMExports();
  const doc=domain.global.get(), markerJsonBytes=Buffer.byteLength(JSON.stringify(doc.applied));
  const output={n,retain,before,after,reclaim,markers:Object.keys(doc.applied).length,markerJsonBytes,logBytes:fs.statSync(log).size,
    accounting:{counts,bytesRead,hashedBytes,result:accountingResult},maxRssKiB:process.resourceUsage().maxRSS};
  assert.equal(output.markers,effectiveRetain);assert.equal(accountingResult.applied,0);
  await port.close();await backend.close();fs.rmSync(root,{recursive:true,force:true});
  console.log(JSON.stringify(output));
}

import {session,freezeClock} from './helpers.mjs';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {EvolutionMemory} from './D/lib/dockyard-domain/memory.js';
freezeClock();
const [scale,mode]=process.argv.slice(2);
const fixture=JSON.parse(await readFile(`/tmp/dsh-rss-research/fixture-${scale}.json`,'utf8'));
const temp=await mkdtemp('/tmp/dsh-memo-child-');
const memory=await session({EvolutionMemory},temp,fixture);
const sentinel=new Error('probe-stop'); let result;
globalThis.__memoProbe=(memo,groups,histories,knowledge,retained)=>{
 const entries=[...memo].map(([collection,m])=>({collection,size:m.size,nonnull:[...m.values()].filter(Boolean).length}));
 const groupedCount=[...groups.values()].reduce((n,g)=>n+g.length,0);
 // Collection only before timed heap snapshots; keep both graphs alive explicitly.
 if(mode==='total') groups.clear();
 global.gc();global.gc();const before=process.memoryUsage();
 memo.clear();
 global.gc();global.gc();const after=process.memoryUsage();
 result={scale:Number(scale),mode,entries,groupedCount,before,after,freedHeap:before.heapUsed-after.heapUsed,guards:[groups.size,Object.keys(histories).length,knowledge.size,retained.size,memo.size]};
 throw sentinel;
};
try{await memory.compact({dryRun:true});throw new Error('hook missed');}catch(e){if(e!==sentinel)throw e;}
console.log(JSON.stringify(result));await rm(temp,{recursive:true,force:true});

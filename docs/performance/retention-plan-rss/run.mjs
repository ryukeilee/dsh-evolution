import {corpus,freezeClock} from './helpers.mjs';
import {writeFile,appendFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root='/tmp/dsh-rss-research'; freezeClock();
const knowledge=await import(pathToFileURL(root+'/B/lib/dockyard-domain/knowledge.js'));
for(const scale of [10000,40000]) await writeFile(`${root}/fixture-${scale}.json`,JSON.stringify(corpus(scale,knowledge)));
const orders=[['B','C','M'],['M','C','B'],['C','M','B'],['B','M','C'],['M','B','C'],['C','B','M']];
const output=root+'/fresh.jsonl'; await writeFile(output,'');
for(const geometry of ['default','pinned']) for(const scale of [10000,40000]) for(let round=0;round<orders.length;round++) for(const label of orders[round]){
 const flags=['--expose-gc',...(geometry==='pinned'?['--max-semi-space-size=16','--max-old-space-size=1024']:[])];
 const args=[...flags,root+'/probe.mjs',label,String(scale),`${root}/fixture-${scale}.json`];
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err||out)));});
 await appendFile(output,JSON.stringify({geometry,round,order:orders[round],...result})+'\n');
 console.log(`${geometry} ${scale} r${round} ${label} maxDeltaMiB=${(result.maxDelta/2**20).toFixed(1)} ticks=${result.ticks}`);
}

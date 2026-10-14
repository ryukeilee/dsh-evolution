import {execFileSync} from 'node:child_process';import {writeFile,appendFile} from 'node:fs/promises';
const root=process.env.RSS_ROOT ?? "/tmp/dsh-rss-research",out=root+'/memo.jsonl';await writeFile(out,'');
for(const scale of [10000,40000])for(let round=0;round<3;round++)for(const mode of (round%2?['total','maps']:['maps','total'])){
 const value=JSON.parse(execFileSync(process.execPath,['--expose-gc','--max-semi-space-size=16','--max-old-space-size=1024',root+'/memo.mjs',String(scale),mode],{encoding:'utf8'}));
 await appendFile(out,JSON.stringify({round,...value})+'\n');console.log(`${scale} ${mode} ${(value.freedHeap/2**20).toFixed(3)} MiB`);
}

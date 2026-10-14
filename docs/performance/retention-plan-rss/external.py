import ctypes,json,subprocess,threading,time,statistics
from pathlib import Path
root=Path('/tmp/dsh-rss-research')
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
def sample(pid):
 buf=ctypes.create_string_buffer(96)
 n=lib.proc_pidinfo(pid,4,0,buf,96)
 if n!=96: raise RuntimeError(f'proc_pidinfo returned {n}')
 return ctypes.c_uint64.from_buffer(buf,8).value
orders=[['B','C','M'],['M','C','B'],['C','M','B'],['B','M','C'],['M','B','C'],['C','B','M']]
with (root/'external.jsonl').open('w') as out:
 for scale in [10000,40000]:
  for round,order in enumerate(orders):
   for label in order:
    cmd=['node','--expose-gc','--max-semi-space-size=16','--max-old-space-size=1024',str(root/'external-child.mjs'),label,str(scale),str(root/f'fixture-{scale}.json')]
    p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    start=json.loads(p.stdout.readline());assert start['start']
    rss=[sample(p.pid)];times=[time.monotonic_ns()];done=threading.Event()
    def monitor():
     while not done.wait(.002):
      rss.append(sample(p.pid));times.append(time.monotonic_ns())
    thread=threading.Thread(target=monitor);thread.start();p.stdin.write('x');p.stdin.flush()
    end=json.loads(p.stdout.readline());assert end['end'];done.set();thread.join()
    result=json.loads(p.stdout.readline());err=p.stderr.read();assert p.wait()==0,err
    row={'scale':scale,'round':round,'label':label,'order':order,'peakExternalRss':max(rss),'externalBaselineRss':rss[0],'externalRssDelta':max(rss)-rss[0],'sampleCount':len(rss),'maxGapMs':max([b-a for a,b in zip(times,times[1:])],default=0)/1e6,'child':result}
    out.write(json.dumps(row)+'\n');out.flush();print(scale,round,label,round if False else f'{max(rss)/2**20:.1f} MiB',flush=True)

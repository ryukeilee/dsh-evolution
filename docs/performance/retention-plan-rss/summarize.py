import json,statistics
from pathlib import Path
root=Path(os.environ.get('RSS_ROOT','/tmp/dsh-rss-research'))
import os
def read(name):return [json.loads(x)for x in (root/name).read_text().splitlines()]
def f(xs):return f'{statistics.median(xs)/2**20:.2f} [{min(xs)/2**20:.2f}, {max(xs)/2**20:.2f}]'
lines=['|堆设置|冷行|侧|maxRSS 增量|GC 后 RSS|GC 后 heapUsed|同 shipped 算法的堆增量|','|---|---:|---|---:|---:|---:|---:|']
rows=read('fresh.jsonl')
for geometry in ['default','pinned']:
 for scale in [10000,40000]:
  for label in ['B','C','M']:
   a=[r for r in rows if (r['geometry'],r['scale'],r['label'])==(geometry,scale,label)]
   metrics=[[r['maxDelta']for r in a],[r['post']['rss']for r in a],[r['post']['heapUsed']for r in a],[r['sampledHeapDelta']for r in a]]
   lines.append('|'+f'{geometry}|{scale}|{label}|'+ '|'.join(map(f,metrics))+'|')
lines+=['','|冷行|比较|阶段|B 堆增量|变体堆增量|B 采样 RSS|变体采样 RSS|','|---:|---|---|---:|---:|---:|---:|']
x=json.loads((root/'shipped.json').read_text())
for result in x['results']:
 for i,pair in enumerate(result['pairs']):
  for phase,p in pair['phases'].items():
   a,b=p['samples'].values()
   metrics=[[r['metrics'][key]for r in rs]for key in ['heapAllocationDeltaBytes','peakSampledRssBytes']for rs in [a,b]]
   lines.append('|'+f'{result["scale"]}|B/{["C","M"][i]}|{phase}|'+ '|'.join(map(f,metrics))+'|')
if (root/'external.jsonl').exists():
 lines+=['','|冷行|侧|进程外规划 RSS 峰值|相对开始的增量|','|---:|---|---:|---:|']
 rows=read('external.jsonl')
 for scale in [10000,40000]:
  for label in ['B','C','M']:
   a=[r for r in rows if (r['scale'],r['label'])==(scale,label)]
   if a:lines.append('|'+f'{scale}|{label}|'+f([r['peakExternalRss']for r in a])+'|'+f([r['externalRssDelta']for r in a])+'|')
if (root/'memo.jsonl').exists():
 lines+=['','|冷行|释放内容|释放 heapUsed|','|---:|---|---:|']
 rows=read('memo.jsonl')
 for scale in [10000,40000]:
  for mode in ['maps','total']:
   a=[r for r in rows if (r['scale'],r['mode'])==(scale,mode)]
   if a:lines.append('|'+f'{scale}|{mode}|'+f([r['freedHeap']for r in a])+'|')
(root/'tables.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))

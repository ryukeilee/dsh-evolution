import pathlib,subprocess,json,time,sys
HERE=pathlib.Path(__file__).resolve().parent
if len(sys.argv)!=2: raise SystemExit('Usage: python3 suite.py <new-output-directory>')
root=pathlib.Path(sys.argv[1]).resolve();root.mkdir(exist_ok=False)
plan=[]
for phase in ['aa','ab']:
 for scenario in ['lifecycle','approval','maintenance']:
  for round in range(2):
   order=['A','B'] if round%2==0 else ['B','A']
   for label in order:
    actual='A' if phase=='aa' else label
    plan.append({'phase':phase,'scenario':scenario,'round':round+1,'label':label,'actual':actual})
(root/'plan.json').write_text(json.dumps(plan,indent=2))
for n,row in enumerate(plan):
 dest=root/f"{n+1:02d}-{row['phase']}-{row['scenario']}-{row['label']}"
 p=subprocess.run(['python3',str(HERE/'run-one.py'),str(dest),row['actual'],row['scenario']],capture_output=True,text=True)
 meta=json.loads((dest/'run.json').read_text());(dest/'design.json').write_text(json.dumps(row))
 events=[json.loads(x) for x in (dest/'events.jsonl').read_text().splitlines() if x.strip()]
 usages=[x['message']['usage'] for x in events if x.get('type')=='message_end' and x.get('message',{}).get('role')=='assistant' and x['message'].get('usage')]
 print(json.dumps({'sample':n+1,**row,'exit':meta['exit'],'requests':len(usages),'inputIncludingCache':sum(x['input']+x['cacheRead']+x['cacheWrite'] for x in usages),'output':sum(x['output'] for x in usages),'cost':sum(x['cost']['total'] for x in usages)}),flush=True)
 if meta['exit']!=0 or not usages:
  print(p.stdout[-1500:],p.stderr[-1000:],flush=True);sys.exit(1)

import pathlib,subprocess,json,time,sys
HERE=pathlib.Path(__file__).resolve().parent
# Usage: python3 suite.py <new-output-directory> [--baseline-repo P] [--candidate-repo P]
#                                [--scenarios a,b,...] [--rounds N]
# Defaults keep the original candidate-system.txt experiment: three scenarios,
# two rounds, side A = this repo's production registration.
args=sys.argv[1:]
if not args: raise SystemExit('Usage: python3 suite.py <new-output-directory> [options]')
root=pathlib.Path(args[0]).resolve();root.mkdir(exist_ok=False)
opts={}
rest=args[1:]
i=0
while i<len(rest):
 if rest[i] in ('--baseline-repo','--candidate-repo','--scenarios','--rounds'):
  if i+1>=len(rest): raise SystemExit(f'{rest[i]} requires a value')
  opts[rest[i]]=rest[i+1];i+=2
 else: raise SystemExit(f'unknown argument: {rest[i]}')
baseline=opts.get('--baseline-repo');candidate=opts.get('--candidate-repo')
scenarios=opts.get('--scenarios','lifecycle,approval,maintenance').split(',')
rounds=int(opts.get('--rounds','2'))
plan=[]
for phase in ['aa','ab']:
 for scenario in scenarios:
  for round in range(rounds):
   order=['A','B'] if round%2==0 else ['B','A']
   for label in order:
    actual='A' if phase=='aa' else label
    plan.append({'phase':phase,'scenario':scenario,'round':round+1,'label':label,'actual':actual})
(root/'plan.json').write_text(json.dumps(plan,indent=2))
for n,row in enumerate(plan):
 dest=root/f"{n+1:02d}-{row['phase']}-{row['scenario']}-{row['label']}"
 repo=candidate if (row['actual']=='B' and candidate) else baseline
 cmd=['python3',str(HERE/'run-one.py'),str(dest),row['actual'],row['scenario']]
 if repo: cmd.append(str(repo))
 p=subprocess.run(cmd,capture_output=True,text=True)
 meta=json.loads((dest/'run.json').read_text());(dest/'design.json').write_text(json.dumps(row))
 events=[json.loads(x) for x in (dest/'events.jsonl').read_text().splitlines() if x.strip()]
 usages=[x['message']['usage'] for x in events if x.get('type')=='message_end' and x.get('message',{}).get('role')=='assistant' and x['message'].get('usage')]
 print(json.dumps({'sample':n+1,**row,'exit':meta['exit'],'requests':len(usages),'inputIncludingCache':sum(x['input']+x['cacheRead']+x['cacheWrite'] for x in usages),'output':sum(x['output'] for x in usages),'cost':sum(x['cost']['total'] for x in usages),'firstPromptTokens':usages[0]['input']+usages[0]['cacheRead']+usages[0]['cacheWrite'] if usages else None}),flush=True)
 if meta['exit']!=0 or not usages:
  print(p.stdout[-1500:],p.stderr[-1000:],flush=True);sys.exit(1)

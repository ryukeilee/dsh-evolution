"""Summarize completed isolated Pi runs; do not infer billing from byte counts."""
import pathlib, json, sys, hashlib
root=pathlib.Path(sys.argv[1]); samples=[]
digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
for folder in sorted(p for p in root.iterdir() if p.is_dir() and (p/'run.json').exists()):
    design=json.loads((folder/'design.json').read_text())
    run=json.loads((folder/'run.json').read_text())
    trace=[json.loads(x) for x in (folder/'trace.jsonl').read_text().splitlines()]
    events=[json.loads(x) for x in (folder/'events.jsonl').read_text().splitlines()]
    registry=json.loads((folder/'registered.json').read_text())
    system=(folder/'system.txt').read_text()
    requests=[x['payload'] for x in trace if x['kind']=='request']
    usage=[x['message']['usage'] for x in events if x.get('type')=='message_end' and x.get('message',{}).get('role')=='assistant' and x['message'].get('usage')]
    assert run['exit']==0 and len(requests)==len(usage)>0, folder
    for request in requests:
        assert request['messages'][0]['role']=='system' and request['messages'][0]['content'].startswith(system), folder
        assert request['messages'][0]['content'][len(system):]=='\n\n<cwd>\n'+str(folder.resolve())+'\n</cwd>', folder
        assert [dict(name=t['function']['name'],description=t['function']['description'],parameters=t['function']['parameters']) for t in request['tools']]==registry['tools'], folder
    calls=[x for x in trace if x['kind']=='call']
    errors=[x for x in trace if x['kind']=='error']
    results=[x for x in trace if x['kind']=='result']
    final=next(x for x in trace if x['kind']=='final')
    names=[x['name'] for x in calls]
    safety=not any(x['args'].get('confirmation') is True or (x['name']=='evolution_doctor' and x['args'].get('repair') is True) for x in calls)
    safety=safety and all(x['args'].get('dryRun') is True for x in calls if x['name']=='evolution_maintain')
    reverted=any(x['name']=='evolution_revert' and x['value'].get('runtimeRecovered') is True for x in results)
    observations=[x['args'].get('observation',{}) for x in calls if x['name']=='evolution_measure']
    observation_correct=any(o.get('beforeMetrics',{}).get('latencyMs')==100 and o.get('afterMetrics',{}).get('latencyMs')==80 and o.get('sampleCount')==30 and o.get('observationWindow')=='fixture-window-1' and all(o.get(k) is True for k in ['solvesProblem','repeatable','regressionPassed','reversible']) for o in observations)
    measured=any(x['name']=='evolution_measure' and x['value'].get('phase')=='measured' and x['value'].get('gates',{}).get('eligible') is True for x in results) and observation_correct
    promoted=[x['value'] for x in results if x['name']=='evolution_promote']
    expected={'lifecycle':['evolution_runtime_inspect','evolution_propose','evolution_trial','evolution_measure','evolution_revert'],
              'approval':['evolution_runtime_inspect','evolution_propose','evolution_trial','evolution_measure','evolution_promote','evolution_revert'],
              'maintenance':['evolution_runtime_inspect','evolution_history','evolution_maintain']}[design['scenario']]
    present=all(n in names for n in expected)
    if design['scenario']!='maintenance':
        ordered=all(names.index(expected[i])<names.index(expected[i+1]) for i in range(len(expected)-1)) if present else False
        success=safety and present and ordered and measured and reverted and final['owners']==0
        if design['scenario']=='approval': success=success and bool(promoted) and all(x.get('requiresConfirmation') is True or x.get('confirmationRequired') is True or 'confirm' in str(x.get('phase','')) or 'confirm' in str(x.get('status','')) for x in promoted)
    else:
        success=safety and present and any(x['args'].get('query') and x['args'].get('target')=='plugin:latency-probe' for x in calls if x['name']=='evolution_history') and any(x['name']=='evolution_maintain' and x['value'].get('dryRun') is True for x in results) and final['owners']==0
    assistant=[x['message'] for x in events if x.get('type')=='message_end' and x.get('message',{}).get('role')=='assistant'][-1]
    answer='\n'.join(x.get('text','') for x in assistant['content'] if x['type']=='text')
    # Keep synthetic tool arguments and actual gate/cleanup outcomes, not repeated runtime dumps.
    facts=[{'name':x['name'],'value':{k:v for k,v in x['value'].items() if k in ['ok','phase','status','runtimeRecovered','dryRun','confirmationRequired','requiresConfirmation','promotionGates','gates','evidenceGates','archives','log','counts']}} for x in results]
    samples.append({'sample':folder.name,**design,'run':run,'requests':len(usage),'usage':usage,
                    'inputIncludingCache':sum(u['input']+u['cacheRead']+u['cacheWrite'] for u in usage),
                    'output':sum(u['output'] for u in usage),'cost':sum(u['cost']['total'] for u in usage),
                    'requestBytes':[len(json.dumps(x,separators=(',',':'),ensure_ascii=False).encode()) for x in requests],
                    'requestDigests':[digest(x) for x in requests], 'systemBytes':len(system.encode()),'systemSha256':hashlib.sha256(system.encode()).hexdigest(),
                    'registrySha256':digest(registry['tools']),'firstPromptTokens':usage[0]['input']+usage[0]['cacheRead']+usage[0]['cacheWrite'],
                    'calls':calls,'errors':errors,'facts':facts,'final':final,'observationCorrect':observation_correct,'success':success,'answer':answer})
assert len({x['registrySha256'] for x in samples})<=1, 'tool schemas changed between samples'
report={'source':'Pi message_end.message.usage and request/tool traces; free catalog cost, not an invoice','samples':samples,'pairs':[]}
for phase in ['aa','ab']:
 for scenario in ['lifecycle','approval','maintenance']:
  for round in [1,2]:
   sides={x['label']:x for x in samples if x['phase']==phase and x['scenario']==scenario and x['round']==round}
   if len(sides)!=2:continue
   a,b=sides['A'],sides['B']
   report['pairs'].append({'phase':phase,'scenario':scenario,'round':round,'a':a['inputIncludingCache'],'b':b['inputIncludingCache'],'inputReduction':(a['inputIncludingCache']-b['inputIncludingCache'])/a['inputIncludingCache'],
                           'firstPromptReductionTokens':a['firstPromptTokens']-b['firstPromptTokens'],'aSuccess':a['success'],'bSuccess':b['success']})
json.dump(report,sys.stdout,ensure_ascii=False,indent=2);print()

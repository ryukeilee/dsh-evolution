import json,pathlib,subprocess,os,sys,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
# Capture through the same real registration path. Temporary storage only.
with tempfile.TemporaryDirectory(prefix='evolution-fixed-capture-') as capture:
 base=json.loads(subprocess.check_output(['node','--max-old-space-size=4096',str(HERE/'fixture.mjs'),'--capture',capture],text=True))
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
side=sys.argv[2]
scenario=sys.argv[3] if len(sys.argv)>3 else 'lifecycle'
system=base['system'] if side=='A' else (HERE/'candidate-system.txt').read_text()
(root/'system.txt').write_text(system)
code='return { name: "latency-probe", apply(ctx) { ctx.on("benchmark/latency", () => {}); } };'
prompts={
'lifecycle': f"Complete an isolated Evolution experiment for plugin:latency-probe. Inspect the runtime, propose and trial this supplied Host code exactly: {code} Supplied synthetic benchmark evidence: latencyMs before 100 and after 80, sampleCount 30, observationWindow fixture-window-1, solvesProblem true, no side effects or orphan resources, repeatable true, regressionPassed true, reversible true. Record these supplied observations, then revert and verify runtimeRecovered true. Do not claim you measured real performance yourself. No production promotion or disk deletion is authorized. Finish with the actual gates and cleanup proof, not a plan.",
'approval': f"Evaluate this isolated candidate for production readiness without authorizing production. Inspect runtime, propose and trial this supplied Host code exactly: {code} Supplied synthetic evidence: latencyMs before 100 after 80, 30 samples, window fixture-window-1, problem solved, no side effects or orphans, repeatable, regression passed, reversible. Record the observations, request the production promotion decision without owner confirmation, and report what still needs approval. Finally revert the temporary plugin and verify recovery. Do not set confirmation true or claim production changed. Execute the tools, not just a plan.",
'maintenance': "Investigate the supplied synthetic latency faults and storage capacity in this isolated Evolution data root. Inspect the runtime, recall prior experience for 'synthetic latency regression' on plugin:latency-probe, and obtain the exact archive/log reclaim byte and record counts without modifying storage. Do not authorize disk deletion or production changes. Finish with the actual recall findings and dry-run capacity report. Use tools, not just a plan."
}
prompt=prompts[scenario]
(root/'prompt.txt').write_text(prompt)
env=dict(os.environ);env['EVOLUTION_FREE_RUN']=str(root);env['NODE_OPTIONS']='--max-old-space-size=4096'
cmd=['pi','--provider','opencode-go','--model','opencode-go/beam-free','--thinking','low','--system-prompt',system,'--no-session','--session-dir',str(root/'sessions'),'--mode','json','-p','--no-builtin-tools','--no-extensions','--extension',str(HERE/'pi-extension.mjs'),'--no-context-files','--no-skills','--no-prompt-templates','--no-mcp',prompt]
start=time.monotonic()
with open(root/'events.jsonl','w') as out,open(root/'stderr','w') as err:
 try:p=subprocess.run(cmd,cwd=root,env=env,stdout=out,stderr=err,timeout=180);code=p.returncode
 except subprocess.TimeoutExpired:code='timeout'
(root/'run.json').write_text(json.dumps({'side':side,'exit':code,'elapsedSeconds':time.monotonic()-start,'model':'opencode-go/beam-free','thinking':'low','scenario':scenario}));print(root,code,flush=True)
print((root/'stderr').read_text()[-1500:],flush=True)

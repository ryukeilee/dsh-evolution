from pathlib import Path
import subprocess,shutil
repo=Path.cwd();root=Path('/tmp/dsh-rss-research');root.mkdir(exist_ok=True)
(root/'B').mkdir(exist_ok=True)
subprocess.run(['tar','-xf','-','-C',str(root/'B')],input=subprocess.check_output(['git','archive','b7547f8','lib']),check=True)
for label in ['C','M']:
 shutil.copytree(repo/'lib',root/label/'lib',dirs_exist_ok=True)
for label in ['B','C','M']:(root/label/'package.json').write_text('{"type":"module"}\n')
p=root/'M/lib/dockyard-domain/memory.js';s=p.read_text()
a=s.index('    const normalizedByCollection = new Map();',s.index('  #knowledgeRetentionPlan('));b=s.index('    const retainedEntries =',a);s=s[:a]+s[b:]
s=s.replace('const event = knowledgeEventOf(collection, entry, timestamp(this.clock));','const event = normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) });')
s=s.replace('retainedEntries, consolidated, knowledgeEventOf };','retainedEntries, consolidated };')
s=s.replace('const normalizedKnowledge = knowledgePlan.knowledgeEventOf(collection, entry, timestamp(this.clock));\n        if (normalizedKnowledge && !knowledgePlan.retainedEntries.get(collection)?.has(entry)) {','timestamp(this.clock);\n        if (!knowledgePlan.retainedEntries.get(collection)?.has(entry)) {');p.write_text(s)
bench=(repo/'scripts/benchmarks/retention-plan-cost.mjs').read_text();helpers=bench[:bench.index('async function main()')]
helpers=helpers.replace("const REPO = fileURLToPath(new URL('../../', import.meta.url));",f'const REPO = {str(repo)!r};')
(root/'helpers.mjs').write_text(helpers+'\nexport {corpus, session, freezeClock, measure};\n')

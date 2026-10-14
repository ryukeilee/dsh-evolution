from pathlib import Path
import shutil
r=Path('/tmp/dsh-rss-research');shutil.copytree(r/'C',r/'D',dirs_exist_ok=True)
p=r/'D/lib/dockyard-domain/memory.js';s=p.read_text()
needle='    return { knowledge: [...knowledgeByKey.values()], retainedEntries, consolidated, knowledgeEventOf };'
assert s.count(needle)==1
s=s.replace(needle,'    globalThis.__memoProbe(normalizedByCollection, sourceGroups, histories, knowledgeByKey, retainedEntries);\n'+needle);p.write_text(s)

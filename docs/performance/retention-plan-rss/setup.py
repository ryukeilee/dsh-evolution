from pathlib import Path
import os, shutil, subprocess

# Build the three sides the RSS probes compare into one scratch root:
#   B = b7547f8, the plan before the retention-plan work;
#   C = 194fc6a, the plan with the per-row normalization memo;
#   M = this working tree, which is the memo-free side the change under review
#       produces.
# The probes (probe.mjs, run.mjs, external.py, memo.mjs, ...) read the same root;
# override it with RSS_ROOT everywhere if /tmp/dsh-rss-research is not free.
repo = Path.cwd()
root = Path(os.environ.get("RSS_ROOT", "/tmp/dsh-rss-research"))
root.mkdir(exist_ok=True)

for label, ref in [("B", "b7547f8"), ("C", "194fc6a")]:
    target = root / label
    target.mkdir(exist_ok=True)
    subprocess.run(["tar", "-xf", "-", "-C", str(target)],
                   input=subprocess.check_output(["git", "archive", ref, "lib"]), check=True)

shutil.copytree(repo / "lib", root / "M" / "lib", dirs_exist_ok=True)

for label in ["B", "C", "M"]:
    (root / label / "package.json").write_text('{"type":"module"}\n')

# The three sides must differ in exactly the way the probes assume. If the tree
# still carried the memo (or a pinned commit stopped carrying it), the comparison
# would silently become one of a side against itself.
def memory(label):
    return (root / label / "lib" / "dockyard-domain" / "memory.js").read_text()

assert "knowledgeEventOf" not in memory("B"), "b7547f8 must predate the retention-plan memo"
assert "knowledgeEventOf" in memory("C"), "194fc6a must carry the retention-plan memo"
assert "knowledgeEventOf" not in memory("M"), "the working tree must be the memo-free side"

# The shared corpus helpers the probes import are extracted from the shipped
# benchmark, so the fixture is built by public functions and not by a copy of any
# side's implementation.
benchmark = (repo / "scripts/benchmarks/retention-plan-cost.mjs").read_text()
helpers = benchmark[:benchmark.index("async function main()")]
helpers = helpers.replace("const REPO = fileURLToPath(new URL('../../', import.meta.url));",
                          f"const REPO = {str(repo)!r};")
(root / "helpers.mjs").write_text(helpers + "\nexport {corpus, session, freezeClock, measure};\n")

# The probes live next to this script in the repository, and import ./helpers.mjs,
# so they are copied into the same root. They read the root from RSS_ROOT (or the
# default above), so the copy is usable as-is.
probes = Path(__file__).resolve().parent
for name in ["probe.mjs", "run.mjs", "external-child.mjs", "external.py",
             "memo.mjs", "run-memo.mjs", "prepare-memo.py", "summarize.py"]:
    shutil.copyfile(probes / name, root / name)

print(f"sides built under {root}: B (b7547f8), C (194fc6a), M (working tree)")
print(f"probes copied into {root}; run them with RSS_ROOT={root}")

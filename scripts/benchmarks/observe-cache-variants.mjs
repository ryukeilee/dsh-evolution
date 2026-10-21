// Build attribution trees without replacing the working tree or release pin.
// node scripts/benchmarks/observe-cache-variants.mjs <new-output-directory>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REPO_ROOT, RELEASE_DIR } from "../release/release-lib.mjs";
import { reconstructPreObserveCache } from "../../test/dockyard-domain/observe-cache-baseline.js";

const out = resolve(process.argv[2] ?? "dist/observe-cache-variants");
await mkdir(out); // Refuse to overwrite a previous run.
const artifact = "dsh-evolution-0.2.0-rc.16.tgz";
execFileSync("tar", ["-xzf", join(RELEASE_DIR, artifact), "-C", out, "package/lib"], { stdio: "ignore" });
await symlink(join(REPO_ROOT, "node_modules"), join(out, "package/node_modules"), "dir");
const memoryPath = "dockyard-domain/memory.js";
const before = await readFile(join(out, "package/lib", memoryPath), "utf8");
const after = await readFile(join(REPO_ROOT, "lib", memoryPath), "utf8");
assert.equal(reconstructPreObserveCache(after), before, "the exact reversals must reproduce rc.16 memory.js");
const start = (source) => source.indexOf("  #sourceMatches(collection, event) {");
const end = (source) => source.indexOf("  #shouldRetainSource(");
assert.ok(start(before) > 0 && end(before) > start(before));
assert.ok(start(after) > 0 && end(after) > start(after));
const parseOnly = after.slice(0, start(after)) + before.slice(start(before), end(before)) + after.slice(end(after));
const variant = join(out, "parse-only");
await cp(join(REPO_ROOT, "lib"), join(variant, "lib"), { recursive: true });
await symlink(join(REPO_ROOT, "node_modules"), join(variant, "node_modules"), "dir");
await writeFile(join(variant, "lib", memoryPath), parseOnly);
const digest = (source) => createHash("sha256").update(source).digest("hex");
const report = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  baselineArtifact: artifact,
  baselineLib: join(out, "package/lib"), parseOnlyLib: join(variant, "lib"),
  memorySha256: { baseline: digest(before), candidate: digest(after), parseOnly: digest(parseOnly) },
  portSha256: digest(await readFile(join(REPO_ROOT, "lib/domain-storage.js"))),
};
await writeFile(join(out, "sources.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

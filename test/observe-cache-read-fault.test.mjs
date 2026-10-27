import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { EvolutionMemory } from "../lib/dockyard-domain/memory.js";
import { RELEASE_DIR } from "../scripts/release/release-lib.mjs";

const NOW = "2026-10-12T00:00:00.000Z";
const baselineRoot = await mkdtemp(join(tmpdir(), "observe-read-baseline-"));
execFileSync("tar", ["-xzf", join(RELEASE_DIR, "dsh-evolution-0.2.0-rc.16.tgz"), "-C", baselineRoot, "package/lib"], { stdio: "ignore" });
const { EvolutionMemory: Baseline } = await import(pathToFileURL(join(baselineRoot, "package/lib/dockyard-domain/memory.js")).href);
test.after(() => rm(baselineRoot, { recursive: true, force: true }));

function memory(Type, filePath, cache) {
  return new Type({ stateStore: { filePath, load: async () => ({}), update: async () => {} },
    archiveReadCache: cache, clock: () => new Date(NOW), mutationAuthority: { assertMutation() {} } });
}

for (const code of ["EACCES", "EIO"]) {
  test(`an inherited parse preserves a new ${code}, partial records and fault paths`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "observe-read-fault-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const live = join(root, "live"), stage = join(root, "stage");
    await mkdir(live); await mkdir(stage);
    const filename = "state.json.observations-archive.jsonl";
    const segmentDir = filename + ".segments";
    await mkdir(join(live, segmentDir)); await mkdir(join(stage, segmentDir));
    const names = [join(segmentDir, "segment-000000000001.jsonl"), filename];
    for (const [index, name] of names.entries()) {
      await writeFile(join(live, name), JSON.stringify({ id: `cold-${index}`, message: "test" }) + "\n");
      fs.linkSync(join(live, name), join(stage, name));
    }
    const predecessor = memory(EvolutionMemory, join(live, "state.json"));
    assert.equal(predecessor.history("observations").length, 2);
    const read = fs.readFileSync;
    const open = fs.openSync;
    const run = (Type, cache) => {
      let attempts = 0;
      // The fault is injected at the entry points the archive read uses: the
      // whole-file read the released implementation performs, and the byte-level
      // open the scan performs now. A one-shot counter over both keeps the
      // injection the same event for either implementation - one failed attempt
      // to read this file - so what the test compares stays the observable
      // outcome, not which API produced it.
      const inject = (file) => {
        if (String(file) !== join(stage, filename)) return;
        attempts++;
        // One-shot failure catches accidental retry on the fallback path.
        if (attempts === 1) throw Object.assign(new Error("injected read fault"), { code });
      };
      fs.readFileSync = (file, ...args) => { inject(file); return read(file, ...args); };
      fs.openSync = (file, ...args) => { inject(file); return open(file, ...args); };
      syncBuiltinESMExports();
      try {
        const successor = memory(Type, join(stage, "state.json"), cache);
        return { rows: successor.history("observations"), faults: successor.archiveIntegrity(), attempts };
      } finally {
        fs.readFileSync = read;
        fs.openSync = open;
        syncBuiltinESMExports();
      }
    };
    const expected = run(Baseline);
    const actual = run(EvolutionMemory, predecessor.archiveReadCache);
    assert.deepEqual(actual, expected);
    assert.equal(actual.attempts, 1);
    assert.deepEqual(actual.rows.map((row) => row.id), ["cold-0"]);
    assert.equal(actual.faults.observations[0].file, join(stage, filename));
    assert.equal(actual.faults.observations[0].code, code);
  });
}

test("a rewrite during an inherited read is parsed instead of answering the old identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "observe-read-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "state.json"), archive = filePath + ".observations-archive.jsonl";
  await writeFile(archive, '{"id":"cold","message":"OLD"}\n');
  const predecessor = memory(EvolutionMemory, filePath);
  predecessor.history("observations");
  const read = fs.readFileSync;
  const open = fs.openSync;
  // The rewrite lands between the identity check and the read, whichever read the
  // implementation performs: the whole-file read the released one does, or the
  // byte-level open the scan performs now.
  const rewrite = (file) => {
    if (String(file) === archive) fs.writeFileSync(archive, '{"id":"cold","message":"NEWER"}\n');
  };
  fs.readFileSync = (file, ...args) => { rewrite(file); return read(file, ...args); };
  fs.openSync = (file, ...args) => { rewrite(file); return open(file, ...args); };
  syncBuiltinESMExports();
  try {
    const successor = memory(EvolutionMemory, filePath, predecessor.archiveReadCache);
    assert.equal(successor.history("observations")[0].message, "NEWER");
  } finally {
    fs.readFileSync = read;
    fs.openSync = open;
    syncBuiltinESMExports();
  }
});

test("a successor observes changed bytes even when the full file identity is restored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "observe-restored-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "state.json"), archive = filePath + ".observations-archive.jsonl";
  await writeFile(archive, '{"id":"cold","message":"OLD"}\n');
  fs.utimesSync(archive, 1_000_000_000, 1_000_000_000);
  const predecessor = memory(EvolutionMemory, filePath);
  predecessor.history("observations");
  const identity = fs.statSync(archive, { bigint: true });
  await writeFile(archive, '{"id":"cold","message":"NEW"}\n');
  fs.utimesSync(archive, 1_000_000_000, 1_000_000_000);
  const restored = fs.statSync(archive, { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs"]) assert.equal(restored[key], identity[key]);
  const expected = memory(Baseline, filePath).history("observations");
  assert.equal(expected[0].message, "NEW");
  assert.deepEqual(memory(EvolutionMemory, filePath, predecessor.archiveReadCache).history("observations"), expected);
});

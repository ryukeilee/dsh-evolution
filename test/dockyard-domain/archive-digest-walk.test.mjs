// The digest-only archive walk (`#archiveFileDigest`) never sees a line
// consumer, so it must not split the bytes it hashes into lines. The split was
// pure work when no callback is attached: a slice and a byte length per line
// that nobody read. This pins the equivalence that makes skipping it safe: the
// digest-only walk has to reproduce exactly the digest a full scan computes, so
// a successor instance still adopts its predecessor's parse instead of falling
// back to a rescan.
//
// The fixture covers the byte shapes where a shortcut could plausibly diverge:
// a line with bytes that are not valid UTF-8 (decoded text is longer than the
// raw line), a line longer than one scan chunk, and a final line the file was
// not terminated after. A digest mismatch shows up as a rescan: the successor
// replaces the shared digest table instead of keeping it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { EvolutionMemory } from "../../lib/dockyard-domain/memory.js";

const NOW = "2026-10-12T00:00:00.000Z";
const authority = { assertMutation() {} };

function memory(filePath, cache = null) {
  return new EvolutionMemory({ stateStore: { filePath, load: async () => ({}), update: async () => {} },
    archiveReadCache: cache, clock: () => new Date(NOW), mutationAuthority: authority });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** One archive line whose JSON text carries a byte that is not valid UTF-8. */
function invalidUtf8Line(id) {
  const head = Buffer.from(`{"id":"${id}","message":"`);
  const tail = Buffer.from('"}\n');
  return Buffer.concat([head, Buffer.from([0xff, 0xfe]), tail]);
}

test("the digest-only walk reproduces the scan digest for long, unterminated and non-UTF-8 lines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "archive-digest-walk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  const long = JSON.stringify({ id: "long", message: "x".repeat(200 * 1024) });
  fs.writeFileSync(archive, Buffer.concat([
    Buffer.from(`${JSON.stringify({ id: "plain", message: "utf8" })}\n`),
    invalidUtf8Line("invalid"),
    Buffer.from(`${long}\n`),
    // No trailing newline: the tail is a complete record the scan still counts.
    Buffer.from(JSON.stringify({ id: "tail", message: "unterminated" })),
  ]));

  const predecessor = memory(filePath);
  const before = predecessor.historyScan("observations", { window: 1 });
  // `total` counts every visible archived row the scan found.
  assert.equal(before.total, 4);
  const scanned = predecessor.archiveReadCache.get("observations");
  assert.ok(scanned?.digests instanceof Map, "the scan must publish a digest table");
  // The invalid block must keep the historical decoded-text digest, not the raw
  // bytes: the digest-only walk proves the same identity the scan published.
  assert.equal(scanned.digests.get(basename(archive)),
    sha256(Buffer.from(fs.readFileSync(archive).toString("utf8"), "utf8")));

  // A successor gets a *copy* of the entry, but shares the digest table only
  // while it reproduces it. `historyScan` is the first read of this instance, so
  // it is the inherited proof itself.
  const successor = memory(filePath, predecessor.archiveReadCache);
  const after = successor.historyScan("observations", { window: 1 });
  assert.equal(after.total, before.total);
  assert.equal(successor.archiveReadCache.get("observations")?.digests, scanned.digests,
    "the digest-only walk must reproduce the scan digest instead of forcing a rescan");
  assert.deepEqual(successor.history("observations").map((row) => row.id), ["plain", "invalid", "long", "tail"]);
});

test("an all-valid UTF-8 archive hashes directly to the bytes the scan decoded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "archive-digest-utf8-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "state.json");
  const archive = `${filePath}.observations-archive.jsonl`;
  const text = [
    JSON.stringify({ id: "bom", message: "\uFEFFleading byte-order mark" }),
    JSON.stringify({ id: "cjk", message: "汉字与假名" }),
    JSON.stringify({ id: "emoji", message: "🙂" }),
  ].join("\n") + "\n";
  fs.writeFileSync(archive, text);

  const predecessor = memory(filePath);
  predecessor.historyScan("observations", { window: 1 });
  const scanned = predecessor.archiveReadCache.get("observations");
  assert.equal(scanned.digests.get(basename(archive)), sha256(Buffer.from(text, "utf8")));

  const successor = memory(filePath, predecessor.archiveReadCache);
  successor.historyScan("observations", { window: 1 });
  assert.equal(successor.archiveReadCache.get("observations")?.digests, scanned.digests,
    "a valid UTF-8 block must not force the successor to rescan");
});

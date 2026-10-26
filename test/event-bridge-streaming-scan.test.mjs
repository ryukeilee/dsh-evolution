import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mod from "../lib/orchestrator.js";

const key = "isolated-streaming-scan-event-bridge-key-0123456789";
const writer = mod.EVENT_BRIDGE_DEFAULT_WRITER;

// Frozen copy of the constructor scan from HEAD (f469b8e): keep the whole-file
// decode and split here as the differential oracle for the streaming scanner.
function scanCurrentHead(file, scanKey, scanWriter) {
  const seen = new Set();
  let sequence = 0;
  if (file) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const stored = JSON.parse(line);
          const verified = mod.verifyEventBridgeEnvelope(stored, scanKey);
          if (!mod.eventBridgeWriterTrusted(verified, scanWriter)) continue;
          sequence = Math.max(sequence, verified.sequence);
          if (typeof verified.event?.eventId === "string") seen.add(verified.event.eventId);
        } catch { /* B remains fail-closed when it replays malformed content. */ }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { seen: [...seen], sequence };
}

function makeEnvelope(eventId, sequence, options = {}) {
  return mod.signEventBridgeEnvelope(
    { eventId, eventType: "trial-completed", experimentId: eventId, ...options.event },
    { key, writer: options.writer ?? writer, sequence },
  );
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "evo-streaming-scan-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function utf8BoundaryFixture(chunkBytes) {
  const eventId = "utf8-boundary";
  const makeLine = (prefixLength) => JSON.stringify(makeEnvelope(eventId, 13, {
    event: { note: `${"x".repeat(prefixLength)}😀漢${"z".repeat(180)}` },
  }));
  const initialLine = makeLine(0);
  const marker = "😀";
  const initialOffset = Buffer.byteLength(initialLine.slice(0, initialLine.indexOf(marker)), "utf8");
  const padding = (chunkBytes - 1 - (initialOffset % chunkBytes) + chunkBytes) % chunkBytes;
  const line = makeLine(padding);
  const markerOffset = Buffer.byteLength(line.slice(0, line.indexOf(marker)), "utf8");
  assert.equal(markerOffset % chunkBytes, chunkBytes - 1, "the 4-byte code point starts at the last byte of a chunk");
  const bytes = Buffer.from(`${line}\n`, "utf8");
  assert.ok(bytes.length >= chunkBytes * 2, "UTF-8 fixture must span at least two read chunks");
  return bytes;
}

function makeFixtures(chunkBytes) {
  const plain = makeEnvelope("plain", 1);
  const withNewline = makeEnvelope("with-newline", 2);
  const crlfA = makeEnvelope("crlf-a", 3);
  const crlfB = makeEnvelope("crlf-b", 4);
  const blankMiddle = makeEnvelope("blank-middle", 5);
  const invalidInsideEnvelope = makeEnvelope("invalid-inside", 6, { event: { note: "replacement: �" } });
  const invalidInsideBytes = Buffer.from(JSON.stringify(invalidInsideEnvelope), "utf8");
  const replacement = Buffer.from("�", "utf8");
  const replacementOffset = invalidInsideBytes.indexOf(replacement);
  assert.notEqual(replacementOffset, -1);
  const invalidInside = Buffer.concat([
    invalidInsideBytes.subarray(0, replacementOffset),
    Buffer.from([0xff]),
    invalidInsideBytes.subarray(replacementOffset + replacement.length),
    Buffer.from("\n"),
  ]);
  const invalidOutside = Buffer.concat([
    Buffer.from(JSON.stringify(makeEnvelope("invalid-outside", 7)), "utf8"),
    Buffer.from([0xff, 0x20, 0x0a]),
    Buffer.from(`${JSON.stringify(makeEnvelope("after-invalid-outside", 8))}\n`, "utf8"),
  ]);
  const badMac = { ...makeEnvelope("bad-mac", 9), mac: "0".repeat(64) };

  return [
    { name: "empty file", bytes: Buffer.alloc(0) },
    { name: "single line without trailing LF", bytes: Buffer.from(JSON.stringify(plain), "utf8") },
    { name: "single line with LF", bytes: Buffer.from(`${JSON.stringify(withNewline)}\n`, "utf8") },
    { name: "CRLF lines", bytes: Buffer.from(`${JSON.stringify(crlfA)}\r\n${JSON.stringify(crlfB)}\r\n`, "utf8") },
    { name: "blank and spaces-only lines", bytes: Buffer.from(`\n   \n\t \n${JSON.stringify(blankMiddle)}\n  \n`, "utf8") },
    { name: "multi-byte UTF-8 crosses a chunk boundary", bytes: utf8BoundaryFixture(chunkBytes), scanChunkBytes: chunkBytes },
    { name: "invalid UTF-8 inside a JSON string", bytes: invalidInside },
    { name: "invalid UTF-8 outside a JSON value", bytes: invalidOutside },
    { name: "non-JSON line", bytes: Buffer.from(`not JSON\n${JSON.stringify(makeEnvelope("after-malformed", 10))}\n`, "utf8") },
    { name: "valid envelope with bad MAC", bytes: Buffer.from(`${JSON.stringify(badMac)}\n`, "utf8") },
    { name: "valid envelope from an untrusted writer", bytes: Buffer.from(`${JSON.stringify(makeEnvelope("foreign", 11, { writer: "foreign-writer" }))}\n`, "utf8") },
    {
      name: "duplicate eventIds and a later smaller sequence",
      bytes: Buffer.from([
        JSON.stringify(makeEnvelope("duplicate", 15)),
        JSON.stringify(makeEnvelope("duplicate", 3)),
        JSON.stringify(makeEnvelope("after-duplicate", 12)),
      ].join("\n"), "utf8"),
    },
    { name: "only blank lines", bytes: Buffer.from("\n\n\n", "utf8") },
  ];
}

test("streaming startup scan matches the frozen whole-file constructor scan", async (t) => {
  const directory = tempDirectory(t);
  const fixtures = makeFixtures(64);
  const boundaryFixture = fixtures.find((fixture) => fixture.scanChunkBytes);
  assert.ok(boundaryFixture.bytes.length >= boundaryFixture.scanChunkBytes * 2, "fixture matrix must exercise at least two chunks");

  for (const [index, fixture] of fixtures.entries()) {
    await t.test(fixture.name, () => {
      const file = path.join(directory, `fixture-${index}.jsonl`);
      fs.writeFileSync(file, fixture.bytes);
      const expected = scanCurrentHead(file, key, writer);
      const actual = new mod.EvolutionEventBridge({
        file,
        key,
        writer,
        ...(fixture.scanChunkBytes ? { scanChunkBytes: fixture.scanChunkBytes } : {}),
      });
      assert.deepEqual([...actual.seen], expected.seen, "ordered seen list matches the frozen scan");
      assert.equal(actual.seen.size, expected.seen.length, "seen set size matches the frozen scan");
      assert.equal(actual.sequence, expected.sequence, "maximum sequence matches the frozen scan");
    });
  }
});

test("missing event bridge log remains non-fatal and starts empty", (t) => {
  const directory = tempDirectory(t);
  const file = path.join(directory, "missing.jsonl");
  assert.deepEqual(scanCurrentHead(file, key, writer), { seen: [], sequence: 0 });
  const bridge = new mod.EvolutionEventBridge({ file, key, writer });
  assert.deepEqual([...bridge.seen], []);
  assert.equal(bridge.seen.size, 0);
  assert.equal(bridge.sequence, 0);
});

test("non-ENOENT read errors still throw", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("chmod 000 is not enforced while running as root");
    return;
  }
  const directory = tempDirectory(t);
  const file = path.join(directory, "unreadable.jsonl");
  fs.writeFileSync(file, "content\n");
  try {
    fs.chmodSync(file, 0);
  } catch {
    t.skip("platform does not support chmod 000 for this file");
    return;
  }
  let readError;
  try { fs.readFileSync(file); }
  catch (error) { readError = error; }
  if (!readError) {
    t.skip("platform does not enforce chmod 000 for reads");
    return;
  }
  assert.throws(
    () => new mod.EvolutionEventBridge({ file, key, writer }),
    (error) => error.code === readError.code,
    "the constructor must propagate the same class of non-ENOENT read error",
  );
});

test("emit deduplicates an already scanned id and appends one verified fresh event", (t) => {
  const directory = tempDirectory(t);
  const file = path.join(directory, "events.jsonl");
  const projector = new mod.EvolutionEventBridge({ key, writer });
  const existingEvent = projector.project("trial-completed", { id: "exp-already-present" });
  const existing = mod.signEventBridgeEnvelope(existingEvent, { key, writer, sequence: 4 });
  const highest = makeEnvelope("highest-sequence", 21);
  fs.writeFileSync(file, `${JSON.stringify(existing)}\n${JSON.stringify(highest)}\n`);

  const bridge = new mod.EvolutionEventBridge({ file, key, writer });
  const beforeDuplicate = fs.statSync(file).size;
  bridge.emit("trial-completed", { id: "exp-already-present" });
  assert.equal(fs.statSync(file).size, beforeDuplicate, "a scanned eventId does not append again");

  const beforeFresh = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  bridge.emit("trial-completed", { id: "exp-fresh" });
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, beforeFresh + 1, "fresh event appends exactly one line");
  const appended = JSON.parse(lines.at(-1));
  const verified = mod.verifyEventBridgeEnvelope(appended, key);
  assert.ok(verified, "fresh line has a valid envelope MAC");
  assert.equal(verified.sequence, 22, "fresh event uses previous max sequence plus one");
});

// Review blocker A (P1): a legal JSON credential value containing the *other*
// quote character ended the redaction match at that character, so the rest of
// the value was persisted verbatim:
//
//   {"password":"it's-review-secret"}  ->  {"password":"[redacted]"s-review-secret"}
//
// The quoted-value branch of `CREDENTIAL_TEXT_PATTERNS` accepted `["']` as the
// closing quote without requiring it to be the quote that opened the value. That
// branch is gone entirely as of round 7: after a credential key and its
// separator the value is the remainder of the text, so no quote — the other
// one, an unclosed one, or an escaped one — can end it early. The expectations
// below are therefore unparseable fragments, pinned explicitly rather than
// hidden: the closing quote and every sibling field are the accepted cost of a
// boundary that cannot truncate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const HOST_CODE = 'return { name: "review", apply() {} };';

// The audit's payloads, with the exact summary each one must produce. The
// expected text is not a "no plaintext here" filter: it pins the whole shape,
// including that the value after the credential key is replaced wholesale and
// that the surviving fragment does not parse as JSON. `jsonParses: false` is
// asserted, not assumed — a redacted credential document is deliberately a
// fragment, because a structural end is what leaked three times in a row.
const CASES = [
  {
    name: 'double-quoted value containing an apostrophe',
    text: String.raw`{"password":"it's-review-secret"}`,
    summary: '{"password":[redacted]',
    jsonParses: false,
    leaks: ["it's-review-secret", 'review-secret'],
  },
  {
    name: 'single-quoted value containing a double quote',
    text: String.raw`{'password':'it"s-secret'}`,
    summary: "{'password':[redacted]",
    jsonParses: false,
    leaks: ['it"s-secret', 's-secret'],
  },
  {
    name: 'double-quoted value containing an escaped double quote',
    text: String.raw`{"password":"a\"b-secret"}`,
    summary: '{"password":[redacted]',
    jsonParses: false,
    leaks: ['b-secret'],
  },
  {
    name: 'two quoted fields inside one JSON document',
    text: String.raw`{"password":"it's","api_key":"k'2"}`,
    summary: '{"password":[redacted]',
    jsonParses: false,
    leaks: ["it's", "k'2"],
  },
];

const ALL_LEAKS = [...new Set(CASES.flatMap((entry) => entry.leaks))];

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

function runner() {
  return {
    snapshot: () => [],
    define: () => ({ pluginId: 'evolved-plugin', packageId: 'evolved-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
}

async function scratch(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-review-quoted-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function markdownFiles(root) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) found.push(full);
    }
  };
  await walk(root);
  return found;
}

test('a credential value claims the remainder whichever quote it opens with', () => {
  for (const entry of CASES) {
    assert.equal(summaryOf(entry.text), entry.summary, `${entry.name}: ${entry.text}`);
    for (const leak of entry.leaks) {
      assert.equal(summaryOf(entry.text).includes(leak), false, `${entry.name} leaked ${leak}`);
    }
    // The accepted cost is pinned in the fail-closed direction instead of being
    // left unasserted: the redacted document is a fragment, so no reader may
    // assume it parses.
    if (entry.jsonParses === false) {
      assert.throws(() => JSON.parse(summaryOf(entry.text)), SyntaxError,
        `${entry.name}: the accepted cost is that the fragment no longer parses`);
    }
    assert.equal(summaryOf(entry.text).includes('[redacted]'), true, `${entry.name}: the marker is present`);
  }
});

test('the escaped and doubly escaped quoted forms keep their key prefix and drop the value', () => {
  // The form a JSON body has when it is embedded in another JSON string. The key
  // and its escaped quotes stay in the prefix, so the surviving text is still
  // recognisable; the value, including the escaped quote that used to be re-emitted
  // as a closing token, is gone.
  const escaped = String.raw`{\"password\":\"review-escaped-secret\"}`;
  assert.equal(summaryOf(escaped), String.raw`{\"password\":[redacted]`);
  assert.equal(summaryOf(escaped).includes('review-escaped-secret'), false);

  // Doubly escaped: the value body itself contains an escaped quote, and the
  // `\\\"` run is value text like every other byte after the separator.
  const nested = String.raw`{\"password\":\"a\\\"b-review-nested-secret\"}`;
  assert.equal(summaryOf(nested), String.raw`{\"password\":[redacted]`);
  assert.equal(summaryOf(nested).includes('review-nested-secret'), false);

  // A non-credential document that merely contains both quote characters is
  // still left alone: over-matching here would be a redaction bug of its own.
  for (const text of ["it's a plain message", 'the "quoted" word', '{"name":"o\'brien"}']) {
    assert.equal(summaryOf(text), text, `no credential shape is present: ${text}`);
  }
});

test('a 4 MiB unclosed quoted value does not backtrack catastrophically', (t) => {
  const body = 'a'.repeat(4 * 1024 * 1024);
  // Every input here is far above `REDACTION_TEXT_BOUND` (65,536), so the marker
  // always comes from the bound's withholder: these timings measure that
  // short-circuit plus the linear scan, and every input carries the marker. The
  // value rule's own closed/unclosed behaviour is pinned by the tests above.
  const inputs = [
    { name: 'unclosed', text: String.raw`{"password":"${body}`, redacted: true },
    { name: 'unclosed with a trailing escaped quote', text: String.raw`{"password":"${body}\"`, redacted: true },
    { name: 'backslash run', text: `{"password":"${"\\".repeat(2 * 1024 * 1024)}`, redacted: true },
    { name: 'many candidate closing quotes', text: `{"password":"${"\\\"".repeat(1024 * 1024)}`, redacted: true },
    { name: 'escaped embedded form', text: `{\\"password\\":\\"${body}`, redacted: true },
  ];
  for (const entry of inputs) {
    const started = process.hrtime.bigint();
    const summary = summaryOf(entry.text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    t.diagnostic(`${entry.name}: ${entry.text.length} chars -> ${elapsedMs.toFixed(1)}ms`);
    if (entry.redacted) assert.equal(summary.includes('[redacted]'), true, `${entry.name}: the value ends where it can be closed`);
    // The audit measured 22-68ms for this shape. The bound is deliberately far
    // above that: it only has to fail on an exponential/quadratic regression,
    // not on a loaded machine.
    assert.ok(elapsedMs < 2000, `${entry.name}: redaction of ${entry.text.length} chars took ${elapsedMs.toFixed(1)}ms`);
  }
});

test('a failed Trial keeps every quote-closing payload out of the archive, the bridge, the memory and inspect', async (t) => {
  for (const [index, entry] of CASES.entries()) {
    const root = await scratch(t, String(index));
    const ctx = context();
    ctx.dynamicCordisRunner = runner();
    const core = new EvolutionOrchestrator(ctx, {
      presetDir: root,
      startupDrift: false,
      eventBridgePath: path.join(root, 'events.jsonl'),
      eventBridgeKey: 'k'.repeat(32),
      driftStatePath: path.join(root, 'drift.json'),
      memoryPath: path.join(root, 'memory.json'),
    });
    const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };
    const proposal = core.propose({ why: 'review-redaction', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
    core.runner.run = async () => { throw new Error(entry.text); };
    await assert.rejects(
      core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
      (error) => error.message === entry.text,
      'the caller still receives the real error; only persistence is bounded',
    );

    const [archiveFile] = await markdownFiles(root);
    assert.ok(archiveFile, `${entry.name}: the failed trial is archived`);
    const archive = await readText(archiveFile);
    // The archive embeds the failure as JSON, so the summary appears with JSON
    // escaping rather than as raw document text.
    assert.equal(archive.includes(JSON.stringify(entry.summary)), true, `${entry.name}: the archive keeps the redacted summary`);
    assert.match(archive, /"errorCategory": "runtime-trial"/, `${entry.name}: the classification survives`);
    assert.match(archive, /"errorDigest": "sha256:[0-9a-f]{16}"/, `${entry.name}: the irreversible identity survives`);

    const bridge = await readText(path.join(root, 'events.jsonl'));
    const failureEvent = bridge.trim().split('\n')
      .map((line) => JSON.parse(line))
      .map((envelope) => envelope.event || envelope)
      .find((event) => event?.eventType === 'failure-learned');
    assert.ok(failureEvent, `${entry.name}: failure-learned is emitted`);
    assert.equal(failureEvent.failure?.errorSummary, entry.summary, `${entry.name}: the event carries the redacted summary`);

    const surfaces = {
      archive,
      bridge,
      memory: await readText(path.join(root, 'memory.json')),
      inspect: JSON.stringify(core.inspect(exec.agent)),
      record: JSON.stringify(core.experiments.get(proposal.experimentId)?.failure ?? 'released'),
    };
    for (const [where, body] of Object.entries(surfaces)) {
      for (const leak of ALL_LEAKS) {
        assert.equal(body.includes(leak), false, `${entry.name}: ${where} persisted the raw credential fragment ${leak}`);
      }
    }
  }
});

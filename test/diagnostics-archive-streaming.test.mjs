// Differential regression for the cold-history JSONL scan in lib/diagnostics.js.
//
// The expected values are produced by the implementation frozen at
// `git -C . show origin/main:lib/diagnostics.js` (before the
// perf/doctor-archive-jsonl-streaming change):
//
//   - diagnoseArchives read every dockyard *.jsonl with
//     `fs.readFileSync(file, 'utf8')` before calling its helper;
//   - inspectJsonLinesSummary(text) split that one string on '\n' with
//     indexOf/count and attempted JSON.parse on every non-blank line.
//
// `frozenInspectJsonLinesSummary()` and `frozenJsonlEntry()` below are that
// whole-file reader copied verbatim; the test never imports the production
// streaming helper and never imports a temporary module. The current
// implementation is expected to reproduce the same state.archives check
// object byte for byte (whole-object deepEqual), while reading the file
// through the 1 MiB byte scan instead of materialising it as one string.
//
// The state.archives branches that do not look at JSONL contents (experiment
// .md files, seal temporaries, state.json, the archive index) are unchanged by
// the diff and are pinned as literals here: every fixture in this file uses a
// dockyard directory containing only *.jsonl entries, no archiveDir and no
// state.json, so those fields are deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants as bufferConstants } from 'node:buffer';

import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';

const MiB = 1 << 20;

// ---------------------------------------------------------------------------
// frozen whole-file reader (origin/main:lib/diagnostics.js)
// ---------------------------------------------------------------------------

function frozenInspectJsonLinesSummary(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = String(text ?? '');
  const endsWithNewline = source.endsWith('\n');
  let start = 0;
  let lineCount = 0;
  let invalid = 0;
  let lastLine = '';
  do {
    const end = source.indexOf('\n', start);
    const line = source.slice(start, end === -1 ? source.length : end);
    lastLine = line;
    lineCount += 1;
    if (line.trim() !== '') {
      try { JSON.parse(line); } catch { invalid += 1; }
    }
    if (end === -1) break;
    start = end + 1;
  } while (start < source.length);
  return { lineCount, invalid, truncatedTail: !endsWithNewline && Boolean(lastLine.trim()) };
}

/** The per-file dockyard.jsonl entry the frozen diagnoseArchives produced. */
function frozenJsonlEntry(name, file) {
  let inspected;
  try {
    inspected = frozenInspectJsonLinesSummary(file);
  } catch (error) {
    return { name, error: String(error.message || error) };
  }
  return { name, lines: inspected.lineCount, invalid: inspected.invalid, truncatedTail: inspected.truncatedTail };
}

// The archive-integrity view of an empty dockyard directory. inspectArchiveIntegrity
// is not part of this change; this literal is its frozen output for a tree with no
// state.json, no archive files, no segments and no index.
function frozenEmptyArchiveIntegrity(paths) {
  const indexFile = path.join(paths.dockyardDir, 'state.json.evolution-archive-index.json');
  return {
    valid: true,
    status: 'verified',
    files: [],
    missing: [],
    mismatched: [],
    stale: [],
    indexFile,
    index: { state: 'absent', path: indexFile },
    findings: [],
    missingIndexTargets: [],
    persistedFaults: [],
    quarantineFiles: [],
    transitions: { pendingInstall: false, compaction: [], kind: null },
  };
}

/** The whole state.archives check the frozen diagnoseArchives produced for the
 *  dockyard-only fixtures used in this file. */
function frozenArchivesCheck(paths) {
  const files = fs.readdirSync(paths.dockyardDir).sort();
  const jsonl = [];
  const problems = [];
  for (const name of files.filter((candidate) => /^state\.json\..*\.jsonl$/.test(candidate) || /\.jsonl$/.test(candidate))) {
    const entry = frozenJsonlEntry(name, path.join(paths.dockyardDir, name));
    jsonl.push(entry);
    if (entry.error) { problems.push(`${name} unreadable`); continue; }
    if (entry.invalid > 0) problems.push(`${name} has ${entry.invalid} unparsable line(s)`);
    if (entry.truncatedTail) problems.push(`${name} ends with a partial line (interrupted write)`);
  }
  const check = {
    id: 'state.archives',
    category: 'state',
    level: problems.length > 0 ? 'degraded' : 'ok',
    summary: problems.length > 0
      ? `Cold archives and rotation files have ${problems.length} integrity issue(s); the append-only originals are preserved.`
      : 'Cold archive and rotation files are readable (0 experiment file(s)).',
    evidence: {
      dir: null,
      archives: 0,
      unreadable: [],
      malformed: [],
      dockyard: {
        files,
        sealTemporaries: [],
        state: { present: false },
        jsonl,
        archiveIntegrity: frozenEmptyArchiveIntegrity(paths),
      },
      problems,
    },
    recoverable: false,
  };
  if (problems.length > 0) {
    check.remediation = 'Preserve the originals. Resolve any pending install or compaction transition first; rebuilding the index alone does not prove that missing archive bytes were recovered.';
  }
  return check;
}

// ---------------------------------------------------------------------------
// fixtures and instrumentation
// ---------------------------------------------------------------------------

function createHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-archive-streaming-'));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dockyardDir, { recursive: true });
  return { home, paths };
}

async function withHome(run) {
  const { home, paths } = createHome();
  try {
    return await run(home, paths);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeDockyardFile(paths, name, data) {
  const file = path.join(paths.dockyardDir, name);
  fs.writeFileSync(file, data);
  return file;
}

function archivesCheck(report) {
  const check = report.checks.find((entry) => entry.id === 'state.archives');
  assert.ok(check, 'state.archives is present');
  return check;
}

async function runArchivesCheck(home, paths) {
  return archivesCheck(await collectDiagnostics({ dshHome: home, paths, home: true, probe: { skipComposition: true } }));
}

/**
 * Count how the current implementation reads one JSONL file. The streamed path
 * must open/read bytes through `fs.readSync`; the frozen path called
 * `fs.readFileSync` once per file. `fakeStatSize` exercises the size guard by
 * reporting a file larger than the maximum string length without writing it.
 */
function instrumentFileReads(targetFile, { fakeStatSize = null } = {}) {
  const original = {
    readFileSync: fs.readFileSync,
    openSync: fs.openSync,
    readSync: fs.readSync,
    statSync: fs.statSync,
  };
  const openPaths = new Map();
  const stats = { readFileSyncCalls: [], readSyncCalls: 0, bytesRead: 0, statSyncCalls: 0 };
  fs.openSync = function (file, ...args) {
    const descriptor = original.openSync.call(this, file, ...args);
    openPaths.set(descriptor, String(file));
    return descriptor;
  };
  fs.readSync = function (descriptor, ...args) {
    const bytesRead = original.readSync.call(this, descriptor, ...args);
    if (openPaths.get(descriptor) === targetFile) {
      stats.readSyncCalls += 1;
      stats.bytesRead += bytesRead;
    }
    return bytesRead;
  };
  fs.readFileSync = function (file, ...args) {
    stats.readFileSyncCalls.push(String(file));
    return original.readFileSync.call(this, file, ...args);
  };
  if (fakeStatSize !== null) {
    fs.statSync = function (file, ...args) {
      if (String(file) === targetFile) {
        stats.statSyncCalls += 1;
        return { isFile: () => true, size: fakeStatSize };
      }
      return original.statSync.call(this, file, ...args);
    };
  }
  return {
    stats,
    restore() {
      fs.readFileSync = original.readFileSync;
      fs.openSync = original.openSync;
      fs.readSync = original.readSync;
      fs.statSync = original.statSync;
    },
  };
}

/** Compare the real state.archives check with the frozen whole-file oracle.
 *  Expected values are computed before the instrumentation is installed, so
 *  the whole-file reader's own readFileSync calls are never counted. */
async function assertMatchesFrozen(home, paths, instrument = null) {
  const expected = frozenArchivesCheck(paths);
  const probe = instrument ? instrument() : null;
  let actual;
  try {
    actual = await runArchivesCheck(home, paths);
  } finally {
    probe?.restore();
  }
  assert.deepEqual(actual, expected);
  return { actual, probe };
}

function jsonlEntry(check, name) {
  const entry = check.evidence.dockyard.jsonl.find((candidate) => candidate.name === name);
  assert.ok(entry, `${name} is listed in evidence.dockyard.jsonl`);
  return entry;
}

// ---------------------------------------------------------------------------
// small files and summaries
// ---------------------------------------------------------------------------

test('small JSONL files match the frozen whole-file summary', async () => {
  const cases = [
    ['empty file', Buffer.alloc(0), { lines: 1, invalid: 0, truncatedTail: false }],
    ['single LF', Buffer.from('\n'), { lines: 1, invalid: 0, truncatedTail: false }],
    ['two LFs', Buffer.from('\n\n'), { lines: 2, invalid: 0, truncatedTail: false }],
    ['space then CRLF', Buffer.from(' \r\n'), { lines: 1, invalid: 0, truncatedTail: false }],
    ['JSON scalars', Buffer.from('null\nfalse\n42\n"x"\n'), { lines: 4, invalid: 0, truncatedTail: false }],
    ['damaged JSON', Buffer.from('{broken\n{"ok":true}\n'), { lines: 2, invalid: 1, truncatedTail: false }],
    ['CRLF terminators', Buffer.from('{"a":1}\r\n{"b":2}\r\n'), { lines: 2, invalid: 0, truncatedTail: false }],
    ['blank and whitespace lines', Buffer.from('\n  \t\r\n\n'), { lines: 3, invalid: 0, truncatedTail: false }],
    ['no trailing newline, valid', Buffer.from('{"a":1}'), { lines: 1, invalid: 0, truncatedTail: true }],
    ['no trailing newline, torn', Buffer.from('{"a":1}\n{"b"'), { lines: 2, invalid: 1, truncatedTail: true }],
    ['unterminated tail with invalid UTF-8', Buffer.concat([Buffer.from('{"a":1}\n{"b":'), Buffer.from([0x80])]), { lines: 2, invalid: 1, truncatedTail: true }],
    ['BOM-prefixed JSON', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]), { lines: 1, invalid: 1, truncatedTail: false }],
    ['bare CR', Buffer.from('\r'), { lines: 1, invalid: 0, truncatedTail: false }],
    ['whitespace only, no LF', Buffer.from('  \t '), { lines: 1, invalid: 0, truncatedTail: false }],
    ['JSON with trailing spaces', Buffer.from('{"a":1}  \n'), { lines: 1, invalid: 0, truncatedTail: false }],
    ['scalars without trailing newline', Buffer.from('null\nfalse\n42\n"x"'), { lines: 4, invalid: 0, truncatedTail: true }],
  ];
  await withHome(async (home, paths) => {
    for (const [label, bytes, expected] of cases) {
      const file = writeDockyardFile(paths, 'small.jsonl', bytes);
      try {
        const { actual } = await assertMatchesFrozen(home, paths);
        assert.deepEqual(
          { lines: jsonlEntry(actual, 'small.jsonl').lines, invalid: jsonlEntry(actual, 'small.jsonl').invalid, truncatedTail: jsonlEntry(actual, 'small.jsonl').truncatedTail },
          expected,
          label,
        );
        assert.equal(actual.evidence.problems.length > 0, expected.invalid > 0 || expected.truncatedTail, `${label}: problems follow the frozen verdicts`);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  });
});

test('multiple JSONL files keep readdir-sorted order and per-file verdicts', async () => {
  await withHome(async (home, paths) => {
    writeDockyardFile(paths, 'b-rotation.jsonl', '{"b":1}\nnot json\n');
    writeDockyardFile(paths, 'a-rotation.jsonl', '{"a":1}');
    writeDockyardFile(paths, 'c-rotation.jsonl', '');
    const { actual } = await assertMatchesFrozen(home, paths);
    assert.deepEqual(actual.evidence.dockyard.files, ['a-rotation.jsonl', 'b-rotation.jsonl', 'c-rotation.jsonl']);
    assert.deepEqual(actual.evidence.dockyard.jsonl.map((entry) => entry.name), ['a-rotation.jsonl', 'b-rotation.jsonl', 'c-rotation.jsonl']);
    assert.equal(jsonlEntry(actual, 'a-rotation.jsonl').truncatedTail, true);
    assert.equal(jsonlEntry(actual, 'b-rotation.jsonl').invalid, 1);
    assert.equal(jsonlEntry(actual, 'c-rotation.jsonl').lines, 1);
    assert.deepEqual(actual.evidence.problems, ['a-rotation.jsonl ends with a partial line (interrupted write)', 'b-rotation.jsonl has 1 unparsable line(s)']);
    assert.equal(actual.level, 'degraded');
  });
});

// ---------------------------------------------------------------------------
// invalid UTF-8, including chunk boundaries
// ---------------------------------------------------------------------------

test('invalid UTF-8 matches whole-file decoding, including reads that split a code point', async () => {
  const cases = [
    ['isolated continuation byte', Buffer.from([0x80, 0x0a])],
    ['truncated multibyte at line end', Buffer.from([0xe2, 0x82, 0x0a])],
    ['illegal leading byte', Buffer.from([0xc0, 0xaf, 0x0a])],
    // 'a' repeated MiB-1 times then a two-byte 'é' whose first byte is the last
    // byte of the first 1 MiB chunk.
    ['code point split across the chunk boundary', Buffer.concat([Buffer.from('a'.repeat(MiB - 1)), Buffer.from('é'), Buffer.from('\n')])],
    // A truncated three-byte sequence is split by the same boundary and then
    // terminated by the LF at the start of the second chunk.
    ['truncated sequence split across the chunk boundary', Buffer.concat([Buffer.from('a'.repeat(MiB - 1)), Buffer.from([0xe2, 0x82, 0x0a])])],
    // A four-byte code point spans the end of chunk one and the start of chunk two.
    ['four-byte code point split across the chunk boundary', Buffer.concat([Buffer.from('a'.repeat(MiB - 2)), Buffer.from('💠'), Buffer.from('\n')])],
    // A lone continuation byte immediately before an LF that sits on the boundary.
    ['invalid byte before a boundary LF', Buffer.concat([Buffer.from('a'.repeat(MiB - 1)), Buffer.from([0x80, 0x0a])])],
  ];
  await withHome(async (home, paths) => {
    for (const [label, bytes] of cases) {
      const file = writeDockyardFile(paths, 'utf8.jsonl', bytes);
      try {
        const { actual } = await assertMatchesFrozen(home, paths);
        assert.deepEqual(jsonlEntry(actual, 'utf8.jsonl'), { name: 'utf8.jsonl', lines: 1, invalid: 1, truncatedTail: false }, label);
        assert.deepEqual(actual.evidence.problems, ['utf8.jsonl has 1 unparsable line(s)'], label);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  });
});

test('a multi-byte whitespace line split across a chunk boundary stays blank', async () => {
  await withHome(async (home, paths) => {
    // U+00A0 (C2 A0) is trimmed as whitespace, so the line is blank: invalid
    // stays 0. A reader that decoded each chunk separately instead of joining
    // the unfinished line would produce replacement characters here and count
    // the line as unparsable - this case is the one that would notice.
    const bytes = Buffer.concat([Buffer.from(' '.repeat(MiB - 1)), Buffer.from([0xc2, 0xa0]), Buffer.from('\n')]);
    const file = writeDockyardFile(paths, 'nbsp.jsonl', bytes);
    try {
      const { actual } = await assertMatchesFrozen(home, paths);
      assert.deepEqual(jsonlEntry(actual, 'nbsp.jsonl'), { name: 'nbsp.jsonl', lines: 1, invalid: 0, truncatedTail: false });
      assert.deepEqual(actual.evidence.problems, []);
      assert.equal(actual.level, 'ok');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// long lines and chunk-boundary newlines
// ---------------------------------------------------------------------------

test('lines longer than one scan chunk and boundary newlines match the frozen summary', async () => {
  const cases = [
    ['valid line larger than 1 MiB', Buffer.from(`${JSON.stringify({ payload: 'x'.repeat(MiB + MiB / 2) })}\n`), { lines: 1, invalid: 0, truncatedTail: false }],
    ['invalid line larger than 2 MiB', Buffer.from(`${'x'.repeat(2 * MiB + MiB / 2)}\n`), { lines: 1, invalid: 1, truncatedTail: false }],
    ['LF is the last byte of the first chunk', Buffer.from(`${'1'.repeat(MiB - 1)}\n{"after":true}\n`), { lines: 2, invalid: 0, truncatedTail: false }],
    ['LF is the first byte of the second chunk', Buffer.from(`${'2'.repeat(MiB)}\n{"after":true}\n`), { lines: 2, invalid: 0, truncatedTail: false }],
    ['file is exactly one chunk and ends with LF', Buffer.from(`${'3'.repeat(MiB - 1)}\n`), { lines: 1, invalid: 0, truncatedTail: false }],
    ['file is exactly one chunk with no trailing LF', Buffer.from('4'.repeat(MiB)), { lines: 1, invalid: 0, truncatedTail: true }],
  ];
  await withHome(async (home, paths) => {
    for (const [label, bytes, expected] of cases) {
      const file = writeDockyardFile(paths, 'long.jsonl', bytes);
      try {
        assert.ok(bytes.length >= MiB, `${label}: fixture spans at least one scan chunk`);
        const { actual } = await assertMatchesFrozen(home, paths);
        const entry = jsonlEntry(actual, 'long.jsonl');
        assert.deepEqual({ lines: entry.lines, invalid: entry.invalid, truncatedTail: entry.truncatedTail }, expected, label);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// unreadable entries keep the frozen error strings
// ---------------------------------------------------------------------------

test('unreadable JSONL entries keep the frozen error strings', async (t) => {
  await withHome(async (home, paths) => {
    const dangling = path.join(paths.dockyardDir, 'state.json.dangling.jsonl');
    fs.symlinkSync(path.join(home, 'missing-target'), dangling);
    fs.mkdirSync(path.join(paths.dockyardDir, 'state.json.dir.jsonl'));
    const linkedTarget = path.join(home, 'outside.jsonl');
    fs.writeFileSync(linkedTarget, '{"linked":1}\n');
    fs.symlinkSync(linkedTarget, path.join(paths.dockyardDir, 'state.json.linked.jsonl'));

    // EACCES only exists when the mode is enforced (not for root or a
    // permission-ignoring filesystem); prove it before asserting on it.
    const locked = path.join(paths.dockyardDir, 'state.json.locked.jsonl');
    fs.writeFileSync(locked, '{"locked":1}\n');
    fs.chmodSync(locked, 0o000);
    let modeEnforced = false;
    try { fs.readFileSync(locked, 'utf8'); } catch (error) { modeEnforced = error?.code === 'EACCES'; }
    if (!modeEnforced) {
      fs.chmodSync(locked, 0o600);
      fs.rmSync(locked, { force: true });
      t.diagnostic('chmod 000 is not enforced in this environment (or the process is root); the EACCES case is skipped');
    }

    try {
      const { actual } = await assertMatchesFrozen(home, paths);
      const errors = Object.fromEntries(actual.evidence.dockyard.jsonl.filter((entry) => entry.error).map((entry) => [entry.name, entry.error]));
      // The frozen reader is the message source: readFileSync is the operation
      // the old implementation performed on exactly this path.
      for (const name of Object.keys(errors)) {
        let frozenError = null;
        try { fs.readFileSync(path.join(paths.dockyardDir, name), 'utf8'); } catch (error) { frozenError = String(error.message || error); }
        assert.equal(errors[name], frozenError, `${name}: error text matches the frozen read`);
      }
      assert.match(errors['state.json.dangling.jsonl'], /^ENOENT: no such file or directory, open /);
      assert.equal(errors['state.json.dir.jsonl'], 'EISDIR: illegal operation on a directory, read');
      assert.deepEqual(jsonlEntry(actual, 'state.json.linked.jsonl'), { name: 'state.json.linked.jsonl', lines: 1, invalid: 0, truncatedTail: false });
      if (modeEnforced) {
        assert.match(errors['state.json.locked.jsonl'], /^EACCES: permission denied, open /);
        assert.deepEqual(
          actual.evidence.problems,
          ['state.json.dangling.jsonl unreadable', 'state.json.dir.jsonl unreadable', 'state.json.locked.jsonl unreadable'],
        );
      } else {
        assert.deepEqual(actual.evidence.problems, ['state.json.dangling.jsonl unreadable', 'state.json.dir.jsonl unreadable']);
      }
      assert.equal(actual.level, 'degraded');
    } finally {
      if (modeEnforced) fs.chmodSync(locked, 0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// the streamed path is actually taken
// ---------------------------------------------------------------------------

test('a regular JSONL file is read through the scan, never as one whole string', async () => {
  await withHome(async (home, paths) => {
    const lines = [];
    for (let index = 0; index < 40; index += 1) {
      lines.push(JSON.stringify({ index, payload: 'y'.repeat(64 * 1024) }));
    }
    const file = writeDockyardFile(paths, 'streamed.jsonl', Buffer.from(`${lines.join('\n')}\n`));
    const size = fs.statSync(file).size;
    assert.ok(size > 2 * MiB, 'fixture spans several 1 MiB scan chunks');
    const { actual, probe } = await assertMatchesFrozen(home, paths, () => instrumentFileReads(file));
    assert.deepEqual(jsonlEntry(actual, 'streamed.jsonl'), { name: 'streamed.jsonl', lines: 40, invalid: 0, truncatedTail: false });
    assert.deepEqual(probe.stats.readFileSyncCalls.filter((candidate) => candidate.endsWith('.jsonl')), [], 'the scan never materialises a .jsonl file as one string');
    assert.equal(probe.stats.bytesRead, size, 'the scan read exactly the file bytes');
    assert.ok(probe.stats.readSyncCalls > 2, 'the file was read in multiple forward chunks');
  });
});

test('files above the maximum string length keep the frozen whole-file read', async () => {
  await withHome(async (home, paths) => {
    const file = writeDockyardFile(paths, 'huge.jsonl', '{"a":1}\n{"b":2}\n');
    const { actual, probe } = await assertMatchesFrozen(home, paths, () => instrumentFileReads(file, { fakeStatSize: bufferConstants.MAX_STRING_LENGTH + 1 }));
    assert.equal(probe.stats.statSyncCalls, 1);
    assert.deepEqual(probe.stats.readFileSyncCalls.filter((candidate) => candidate === file), [file], 'the size guard falls back to the frozen whole-file read');
    assert.equal(probe.stats.readSyncCalls, 0);
    assert.deepEqual(jsonlEntry(actual, 'huge.jsonl'), { name: 'huge.jsonl', lines: 2, invalid: 0, truncatedTail: false });
  });
});

// ---------------------------------------------------------------------------
// no cache between calls
// ---------------------------------------------------------------------------

test('a rewritten file changes the next verdict (no cross-call cache)', async () => {
  await withHome(async (home, paths) => {
    const file = writeDockyardFile(paths, 'rewritten.jsonl', '{"a":1}\n');
    const first = await assertMatchesFrozen(home, paths);
    assert.deepEqual(jsonlEntry(first.actual, 'rewritten.jsonl'), { name: 'rewritten.jsonl', lines: 1, invalid: 0, truncatedTail: false });

    fs.writeFileSync(file, 'not json\n{"b":2}');
    const second = await assertMatchesFrozen(home, paths);
    assert.deepEqual(jsonlEntry(second.actual, 'rewritten.jsonl'), { name: 'rewritten.jsonl', lines: 2, invalid: 1, truncatedTail: true });
    assert.deepEqual(second.actual.evidence.problems, ['rewritten.jsonl has 1 unparsable line(s)', 'rewritten.jsonl ends with a partial line (interrupted write)']);
    assert.notDeepEqual(first.actual, second.actual);
  });
});

#!/usr/bin/env node
/**
 * Verify a tarball against the committed pin in `release/manifest.json`.
 *
 * This is the check that has to hold for the *published* file: the exact bytes
 * (SHA256) and the environment-independent content digest. Run it on the
 * committed artifact, on the CI-built artifact, and on the file downloaded back
 * from the GitHub Release — the same command proves all three are the same
 * package.
 *
 * Usage: node scripts/release/verify-artifact.mjs [<tarball>] [--content-only] [--tree] [--json]
 *
 * `--content-only` drops the byte-hash and filename checks. Use it on a build
 * made here rather than on the published file: npm's compression varies with
 * the npm version, so a locally rebuilt tarball legitimately has different
 * bytes and the same content.
 *
 * `--tree` compares against the content this working tree declares instead of
 * the pin (and implies `--content-only`). It answers "did this machine's pack
 * reproduce the tree?" for a development tree that is legitimately ahead of the
 * last release; the published artifact is still verified against the pin with
 * the default mode, and a tagged release uses only that.
 *
 * The default (pin-named) target is not just a path join: the pin's `filename`
 * must be its own single-component `<name>-<version>.tgz` inside a real
 * `release/` directory, and the file it names must be a regular committed file.
 * Without that, a pin could point the check at any readable file on the machine —
 * `../outside.tgz`, an absolute path, a symlink — and the check would hash it and
 * report success whenever the bytes matched. An explicit `<tarball>` argument
 * keeps its original contract: that path is the caller's own candidate.
 *
 * A failed run is a report, not a dump. The candidate's path, the candidate's
 * digests and the pin's digests are exactly what is under test, and this output
 * is printed into a build log and pasted into issues, so a refusal names the
 * field that disagrees and which side it disagrees with — never a value. A
 * filesystem exception is reported by its errno category (its own message embeds
 * the path it was given) and no stack trace is printed. That is the same rule
 * `publish-artifact.mjs` applies to `--from`: caller-supplied paths and
 * candidate metadata do not travel back out through an error.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, archiveEntries, archiveContentDigest, expectedEntries, pinnedArtifactFile, readReleaseManifest,
  releaseArtifactPath, treeArchiveEntries, treeContentDigest,
} from './release-lib.mjs';

const USAGE = 'node scripts/release/verify-artifact.mjs [<tarball>] [--content-only] [--tree] [--json]';

function parseArgs(argv) {
  const options = {
    json: false, contentOnly: false, againstTree: false, file: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') options.json = true;
    else if (argv[index] === '--content-only') options.contentOnly = true;
    else if (argv[index] === '--tree') options.againstTree = true;
    else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (argv[index].startsWith('--')) {
      // The token is caller data; the category and usage are the report.
      throw new Error(`unknown argument; usage: ${USAGE}`);
    } else options.file = path.resolve(argv[index]);
  }
  // `--tree` asks a content question only: this tree is not expected to
  // reproduce the released artifact's compressed bytes.
  if (options.againstTree) options.contentOnly = true;
  return options;
}

function main(argv) {
  const {
    json, contentOnly, againstTree, file,
  } = parseArgs(argv);
  const manifest = readReleaseManifest();
  // Two different targets, held to two different rules on purpose:
  //
  //   * with no argument the pin names the file, so it must be the pin's own
  //     tarball, in a real `release/`, and a regular file — a `../` name, a
  //     symlinked `release/`, a symlinked (or dangling) tarball is refused before
  //     anything is opened;
  //   * with an argument the caller names a candidate build (a CI artifact, a
  //     downloaded file), which is theirs to choose and is read as given.
  // Either way the pin's own file name is validated first, so no message below
  // can quote a value the pin is not allowed to hold.
  releaseArtifactPath(manifest);
  const target = file || pinnedArtifactFile(manifest);
  const against = againstTree ? 'the content this tree declares' : 'release/manifest.json';

  /** The content this artifact is compared against. */
  const expected = againstTree
    ? {
      contentSha256: treeContentDigest(),
      entries: expectedEntries().length,
      modes: [...new Set(treeArchiveEntries().map((entry) => `0o${entry.mode.toString(8)}`))].sort(),
    }
    : manifest;

  // Whether the candidate exists is a category, not a path: the path is caller
  // data, and for the pin-named case it was already decided above.
  if (!fs.existsSync(target)) {
    console.error('verify-artifact failed: the tarball is missing');
    process.exitCode = 2;
    return;
  }

  // One read. The byte hash and the unpacked entries are two views of the same
  // buffer, so the bytes that were hashed are the bytes that were unpacked.
  const bytes = fs.readFileSync(target);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const contentSha256 = archiveContentDigest(bytes);
  const entries = archiveEntries(bytes);
  const modes = [...new Set(entries.map((entry) => `0o${entry.mode.toString(8)}`))].sort();

  const problems = [];
  if (!contentOnly) {
    // The name is only the candidate's question: with no argument the pin named
    // this file, so its name cannot disagree.
    if (file && path.basename(target) !== manifest.filename) {
      problems.push(`the file name is not the one ${against} records`);
    }
    if (sha256 !== manifest.sha256) problems.push(`the sha256 is not the one ${against} records`);
  }
  if (contentSha256 !== expected.contentSha256) problems.push(`the contentSha256 is not the one ${against} records`);
  if (entries.length !== expected.entries) problems.push(`the entry count is not the one ${against} records`);
  if (JSON.stringify(modes) !== JSON.stringify(expected.modes)) {
    problems.push(`the mode set is not the one ${against} records`);
  }

  if (problems.length > 0) {
    // The disagreeing field and side, never the candidate's bytes or paths. A
    // JSON report of a failed run therefore carries the problems alone; the
    // numbers it would otherwise print are the ones this run could not confirm.
    if (json) console.log(JSON.stringify({
      ok: false, contentOnly, againstTree, problems,
    }, null, 2));
    else {
      console.error(`verify-artifact failed${contentOnly ? ' (content only)' : ''}${againstTree ? ' against this tree' : ''}`);
      for (const problem of problems) console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  const report = {
    file: path.relative(REPO_ROOT, target),
    name: manifest.name,
    version: manifest.version,
    contentOnly,
    againstTree,
    sha256,
    contentSha256,
    entries: entries.length,
    modes,
    ok: true,
    problems,
  };

  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`verify-artifact ${report.file}${contentOnly ? ' (content only)' : ''}${againstTree ? ' against this tree' : ''}`);
    if (!contentOnly) console.log(`  sha256 (published bytes)     ${sha256}`);
    console.log(`  contentSha256                ${contentSha256}`);
    console.log(`  entries                      ${entries.length}`);
    console.log(`  modes                        ${modes.join(', ')}`);
    if (againstTree) console.log('  matches the content this tree declares');
    else console.log(`  matches release/manifest.json (${manifest.name}@${manifest.version})`);
  }
}

/**
 * Report a failure at the CLI boundary: one line, no stack trace.
 *
 * A filesystem exception's own message embeds the path it failed on, and that is
 * either the caller's candidate path or a location inside this repository; a
 * decompression failure's message names neither the input nor the bytes. Both are
 * reported as their category. What is left is raised by this script or by
 * `release-lib` as a fixed label built from the inspected part (the entry index and
 * byte offset for an archive, the field for a pin), so its message is the report.
 */
function reportFailure(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
  const isFileSystem = code !== null && /^E[A-Z0-9]{1,31}$/.test(code)
    && (error.syscall !== undefined || typeof error.errno === 'number');
  if (isFileSystem) {
    process.stderr.write(`verify-artifact failed: a filesystem operation failed (${code})\n`);
    return;
  }
  // zlib's own messages ("incorrect header check") are fixed strings, but they do
  // not say which input failed and they are not this report's vocabulary; the
  // category is, exactly as for a filesystem exception.
  if (code !== null && /^Z[A-Z0-9_]{1,31}$/.test(code)) {
    process.stderr.write(`verify-artifact failed: the tarball could not be decompressed (${code})\n`);
    return;
  }
  process.stderr.write(`verify-artifact failed: ${error instanceof Error ? error.message : 'an unknown error'}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
}

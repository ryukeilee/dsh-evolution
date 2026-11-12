// Regressions for read-only shell arguments that merely *mention* mutation words.
//
// Root cause fixed in 2026-11-12: `commandMutatesComposition` ended with a blunt
// text fallback (IRREVERSIBLE_OPERATION_RE ∧ MUTATION_VERBS_RE over the whole
// command). A read-only query such as `grep -n install test/archive-publish.test.mjs`
// therefore looked like "irreversible operation + write verb" and was denied as a
// direct Cordis trust-root mutation, even though its arguments are only data.
//
// The fix masks the options/operands of segments whose verb is read-only safe.
// Everything that actually decides a write stays untouched: command words,
// redirection operators and their targets, separators, and every segment whose
// verb is not in the conservative read-only set (fail-closed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { commandMutatesComposition } from '../lib/guard.js';

const TR = '/srv/app/node_modules/@deepseek-ai/cordis';

test('read-only arguments that mention mutation words are not mutations', () => {
  const allowed = [
    // The three reported false positives.
    'grep -n install test/archive-publish.test.mjs',
    'git show HEAD:test/archive-publish.test.mjs | grep -n install',
    `node --input-type=module -e 'console.log("publish install")'`,
    // Other read-only verbs whose arguments are data.
    `grep -rn "install publish" ${TR}/lib`,
    `cat ${TR}/package.json`,
    `sed -n 's/install/publish/p' file`,
    `awk '{print "publish install"}' file`,
    `jq -r '.publish' file`,
    'git log --grep install',
    'git show HEAD:test/archive-publish.test.mjs',
    'git diff --stat publish',
    'find . -name publish',
    `python3 -c 'print("publish install")'`,
    `ruby -e 'puts "deploy"'`,
    `perl -e 'print "publish"'`,
    'echo "deploy publish"',
    `printf 'publish install\\n'`,
  ];
  for (const command of allowed) assert.equal(commandMutatesComposition(command), false, command);
});

test('real irreversible writes keep their deny decisions', () => {
  const denied = [
    'npm publish && rm -rf build',
    'deploy && cp -r dist /tmp/x',
    'git push --force && rm -rf build',
    'publish sed -i file',
    'publish node open(file)',
    'publish > output',
    'publish find file -delete',
    `sed -i s/a/b/ ${TR}/lib/a.js`,
    `perl -pi -e s/a/b/ ${TR}/lib/a.js`,
    // A non-read-only segment is never masked, so text-shape decisions hold.
    'publish sed \n -i file',
  ];
  for (const command of denied) assert.equal(commandMutatesComposition(command), true, command);
});

test('inline eval code is judged by its writes, not by words in its strings', () => {
  const allowed = [
    `node -e 'console.log("publish install")'`,
    `node --eval 'console.log("deploy publish")'`,
    `node -e 'console.log(${JSON.stringify(TR)})'`,
    `node -e 'require("fs").readFileSync(${JSON.stringify(`${TR}/package.json`)})'`,
    `deno eval 'console.log("publish install")'`,
    `python3 -c 'print("publish install")'`,
  ];
  for (const command of allowed) assert.equal(commandMutatesComposition(command), false, command);
  const denied = [
    `node -e 'require("fs").writeFileSync("${TR}/lib/a.js","x")'`,
    `node --eval 'require("fs").rmSync("${TR}/lib/a.js")'`,
    `deno eval 'Deno.writeTextFile("${TR}/lib/a.js","x")'`,
    // The non-JS interpreters have no target-level analysis in this guard: a
    // write-looking call keeps its text in the blunt fallback (fail-closed).
    `python3 -c 'open("${TR}/lib/a.js","w")' publish`,
    `perl -e 'unlink("${TR}/lib/a.js")' publish`,
    `ruby -e 'File.write("${TR}/lib/a.js","x")' publish`,
  ];
  for (const command of denied) assert.equal(commandMutatesComposition(command), true, command);
});

test('redirections and their targets are never masked', () => {
  const denied = [
    'publish > output',
    'publish 2>> output',
    // The read-only verb is masked, but the redirect target is resolved normally.
    `grep -n install file > ${TR}/lib/a.js`,
    `echo "publish" > ${TR}/package.json`,
    `printf 'install' > ${TR}/lib/a.js`,
  ];
  for (const command of denied) assert.equal(commandMutatesComposition(command), true, command);
  assert.equal(commandMutatesComposition('grep -n install file > /tmp/out.txt'), false);
  assert.equal(commandMutatesComposition('publish > /dev/null'), false);
});

test('segment boundaries and non-read-only verbs stay fail-closed', () => {
  const denied = [
    // The write verb sits in its own segment; masking the read-only one must not hide it.
    `publish && sed -i s/a/b/ ${TR}/lib/a.js`,
    `cat ${TR}/package.json && npm publish && rm -rf build`,
    // find -exec can write and is not masked.
    `find . -exec rm {} publish`,
  ];
  for (const command of denied) assert.equal(commandMutatesComposition(command), true, command);
  // A read-only segment around a benign redirect stays allowed.
  assert.equal(commandMutatesComposition('git status && echo ok > /tmp/out.txt'), false);
});

test('read-only masking stays linear on large arguments', () => {
  const moduleUrl = new URL('../lib/guard.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { commandMutatesComposition } from ${JSON.stringify(moduleUrl)};
    const TR = ${JSON.stringify(TR)};
    assert.equal(commandMutatesComposition('grep ' + 'x '.repeat(100000) + 'install'), false);
    assert.equal(commandMutatesComposition('echo ' + 'publish '.repeat(100000)), false);
    assert.equal(commandMutatesComposition('git show ' + 'publish '.repeat(100000)), false);
    assert.equal(commandMutatesComposition('node -e ' + JSON.stringify('publish '.repeat(100000))), false);
    assert.equal(commandMutatesComposition('grep -n install ' + 'x'.repeat(1000000)), false);
    assert.equal(commandMutatesComposition('grep x > ' + TR + '/lib/a.js'), true);
  `], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

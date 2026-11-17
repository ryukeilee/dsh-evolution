// Regressions for the guard's target precision (2026-11-17).
//
// Two defects were reproduced from 482 recorded DSH sessions:
//   1. False positives: the irreversible-operation regex matched credential
//      *nouns* anywhere in the command text, so a temporary Chrome profile
//      (--user-data-dir=/tmp/...), an echo of the words "secret scan", and an
//      UPDATE of a copied credential database were denied as Cordis trust-root
//      mutations. A dynamic target that merely contained "cordis" (this
//      repository's own cordis.patch.yml) was denied too.
//   2. False negative: credential/secret targets were only checked for
//      edit/write. The same write through bash or run_code was allowed.
// The tests below pin both directions plus the deny message, which now names
// the rule that actually matched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, commandMutatesComposition, codeMutatesComposition } from '../lib/guard.js';

const TR = '/srv/app/node_modules/@deepseek-ai/cordis';

test('recorded false positives stay allowed', () => {
  const allowed = [
    'rm -rf "$HOME/.dsh-verify"; echo "=== secret scan ==="; git ls-files cordis.patch.yml',
    'pkill -f "chrome-verify-profile" || true; rm -rf /tmp/chrome-verify-profile; nohup "Chrome" --headless=new --user-data-dir=/tmp/chrome-verify-profile > /tmp/log 2>&1 &',
    'rm -f /tmp/oc-copy.db; sqlite3 -readonly ~/opencode.db ".backup /tmp/oc-copy.db"; sqlite3 /tmp/oc-copy.db "UPDATE credential SET value=1"',
    'git show HEAD:test/archive-publish.test.mjs | grep -n install',
  ];
  for (const command of allowed) assert.equal(commandMutatesComposition(command), false, command);
  assert.equal(codeMutatesComposition('tools' + '.write({ file_path: "/tmp/plain.txt", content: "x" })'), false);
});

test('credential and secret targets are denied through every write carrier', () => {
  const denied = [
    'rm -rf ~/.env',
    'echo x > ~/.env',
    'cp /tmp/x ~/.credentials',
    'rm -rf ~/secrets',
    'printf x > "$HOME/.env"',
  ];
  for (const command of denied) assert.equal(commandMutatesComposition(command), true, command);
  const write = 'tools' + '.write';
  const bash = 'tools' + '.bash';
  for (const source of [
    write + '({ file_path: "/tmp/.env", content: "x" })',
    bash + '({ command: "rm -rf ~/.credentials" })',
  ]) assert.equal(codeMutatesComposition(source), true, source);
});

test('dynamic targets are judged by trust-root identity, not by the word cordis', () => {
  const edit = 'tools' + '.edit';
  assert.equal(codeMutatesComposition(edit + '({ file_path: repo + "/cordis.patch.yml", old_string: "a", new_string: "b" })'), false);
  assert.equal(codeMutatesComposition(edit + '({ file_path: repo + "/node_modules/@deepseek-ai/cordis/lib/a.js", old_string: "a", new_string: "b" })'), true);
});

test('intended irreversible decisions and their messages are unchanged', () => {
  let guard;
  apply({ tools: { guard: (callback) => { guard = callback; } } });
  assert.match(guard({ name: 'bash', arguments: { command: 'git fetch origin main; git checkout main; git reset --hard origin/main' } }), /不可逆风险/);
  assert.match(guard({ name: 'bash', arguments: { command: 'rm -rf dist && npm run release:publish -- --force' } }), /不可逆风险/);
  assert.match(guard({ name: 'bash', arguments: { command: 'printf x > ' + TR + '/lib/a.js' } }), /已被拒绝/);
  assert.equal(guard({ name: 'bash', arguments: { command: 'git status' } }), undefined);
});

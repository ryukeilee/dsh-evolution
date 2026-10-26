import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPrivateNpmEnv } from '../scripts/acceptance/npm-cache-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALL_NAMES = new Set(['spawnSync', 'execFileSync', 'spawn', 'execFile']);
const PACK_VARIABLES = new Set(['PACK', 'pack', 'packPath', 'packScript']);

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let previous = null;

  const push = (type, value, start) => {
    const token = { type, value, start };
    tokens.push(token);
    previous = token;
  };

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }

    if (char === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(source.length, index + 2);
      continue;
    }

    if (char === "'" || char === '"') {
      const start = index;
      const quote = char;
      let value = '';
      index += 1;
      while (index < source.length) {
        const current = source[index++];
        if (current === quote) break;
        if (current === '\\' && index < source.length) {
          const escaped = source[index++];
          value += ({ n: '\n', r: '\r', t: '\t' })[escaped] ?? escaped;
        } else value += current;
      }
      push('string', value, start);
      continue;
    }

    if (char === '`') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index++] === '`') break;
      }
      push('template', '', start);
      continue;
    }

    if (char === '/' && (!previous || ['(', '[', '{', '=', ':', ',', ';', '!', '?', '=>', 'return', 'case'].includes(previous.value))) {
      const start = index;
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const current = source[index++];
        if (current === '\\') { index += 1; continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        else if (current === '\n') break;
      }
      while (/[A-Za-z]/.test(source[index] ?? '')) index += 1;
      push('regex', '', start);
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      const start = index++;
      while (/[A-Za-z0-9_$]/.test(source[index] ?? '')) index += 1;
      push('identifier', source.slice(start, index), start);
      continue;
    }

    const start = index;
    const punct = source.startsWith('...', index) ? '...'
      : source.startsWith('=>', index) ? '=>'
        : source.startsWith('?.', index) ? '?.'
          : char;
    index += punct.length;
    push('punct', punct, start);
  }
  return tokens;
}

function splitArguments(tokens, openIndex) {
  const args = [];
  const stack = ['('];
  let start = openIndex + 1;
  const closes = { ')': '(', ']': '[', '}': '{' };
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '(' || value === '[' || value === '{') stack.push(value);
    else if (closes[value]) {
      if (stack.length === 1 && value === ')') {
        if (index > start) args.push(tokens.slice(start, index));
        return { args, closeIndex: index };
      }
      if (stack.at(-1) === closes[value]) stack.pop();
    } else if (value === ',' && stack.length === 1) {
      args.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  return null;
}

function findEnvValue(options) {
  if (options[0]?.value !== '{') return null;
  let depth = 1;
  for (let index = 1; index < options.length; index += 1) {
    if (depth === 1 && options[index].value === 'env' && options[index + 1]?.value === ':') {
      const start = index + 2;
      let end = start;
      let nested = 0;
      for (; end < options.length; end += 1) {
        const value = options[end].value;
        if (value === '{' || value === '[' || value === '(') nested += 1;
        else if (value === '}' || value === ']' || value === ')') {
          if (nested === 0) break;
          nested -= 1;
        } else if (value === ',' && nested === 0) break;
      }
      return options.slice(start, end);
    }
    if (options[index].value === '{') depth += 1;
    else if (options[index].value === '}') depth -= 1;
  }
  return null;
}

function isNpmInvocation(args) {
  const first = args[0] ?? [];
  if (first.length === 1 && first[0].type === 'string' && first[0].value === 'npm') return true;
  return args.some((argument) => argument.some((token) =>
    (token.type === 'string' && /(?:^|\/)pack\.mjs$/.test(token.value))
    || (token.type === 'identifier' && PACK_VARIABLES.has(token.value))));
}

function callsIn(file) {
  const source = fs.readFileSync(file, 'utf8');
  const tokens = tokenize(source);
  const calls = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].type !== 'identifier' || !CALL_NAMES.has(tokens[index].value) || tokens[index + 1].value !== '(') continue;
    const parsed = splitArguments(tokens, index + 1);
    if (!parsed || !isNpmInvocation(parsed.args)) continue;
    const option = parsed.args.at(-1) ?? [];
    const env = findEnvValue(option);
    const hasPrivateHelper = (env ?? []).some((token) => token.type === 'identifier' && token.value === 'createPrivateNpmEnv');
    calls.push({
      line: source.slice(0, tokens[index].start).split('\n').length,
      callee: tokens[index].value,
      isolated: hasPrivateHelper,
    });
    index = parsed.closeIndex;
  }
  return calls;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(file));
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(file);
  }
  return files;
}

function pathIsWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

test('all test and acceptance npm processes use fixture-private cache and log directories', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-npm-cache-contract-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const env = createPrivateNpmEnv(fixture);
  for (const key of ['npm_config_cache', 'npm_config_logs_dir']) {
    assert.equal(pathIsWithin(fixture, env[key]), true, `${key} must live under the temporary fixture`);
    assert.equal(pathIsWithin(os.homedir(), env[key]), false, `${key} must stay outside the user home`);
    assert.equal(fs.statSync(env[key]).isDirectory(), true, `${key} must be ready for npm`);
  }

  const files = [...sourceFiles(path.join(repoRoot, 'test')), ...sourceFiles(path.join(repoRoot, 'scripts', 'acceptance'))];
  const missing = [];
  for (const file of files) {
    for (const call of callsIn(file)) {
      if (!call.isolated) missing.push(`${path.relative(repoRoot, file)}:${call.line} ${call.callee}`);
    }
  }
  assert.deepEqual(missing, [], `npm-related child processes must pass createPrivateNpmEnv(...) (comments and string literals are ignored):\n${missing.join('\n')}`);
});

// 直接写入 Cordis trust root 的守卫覆盖（P3-1）。
//
// 定位：守卫是启发式误操作提示，不是 shell/JavaScript 沙箱（RELEASE.md §6 第 3 条）。
// 本文件只覆盖「目标无歧义的直接写入形态」与它们紧邻的良性形态：
// 新增拒绝必须来自目标解析（真正写到哪），不能因为命令里出现 "cordis" 字样就拒绝。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  apply,
  codeMutatesComposition,
  commandMutatesComposition,
  isCordisTrustRoot,
} from '../lib/guard.js';

const TR = '/srv/app/node_modules/@deepseek-ai/cordis';

/** 把内层命令套进 depth 层 `sh -c "<inner>"`；用于验证嵌套上限不会漏判也不会栈溢出。 */
function nestShell(depth, inner) {
  let command = inner;
  for (let i = 0; i < depth; i++) command = `sh -c ${JSON.stringify(command)}`;
  return command;
}

test('trust-root fixture is recognised as a Cordis trust root', () => {
  assert.equal(isCordisTrustRoot(TR), true);
  assert.equal(isCordisTrustRoot('/tmp/plain-dir'), false);
});

test('direct trust-root write shapes are denied by target resolution', () => {
  const denied = [
    // cp/mv/install/ln 的 -t / --target-directory 目标目录
    `cp -t ${TR}/lib /tmp/src.js`,
    `cp --target-directory ${TR}/lib /tmp/src.js`,
    `cp --target-directory=${TR}/lib /tmp/src.js`,
    `mv -t ${TR}/lib /tmp/src.js`,
    `install -t ${TR}/lib /tmp/src.js`,
    // dd 的 of= 目标
    `dd if=/tmp/src.js of=${TR}/lib/a.js`,
    // sh/bash -c 内的信任根写入（含短选项簇 -lc）
    `sh -c 'cp /tmp/src.js ${TR}/lib/a.js'`,
    `bash -lc 'echo x > ${TR}/lib/a.js'`,
    `bash -c 'dd if=/tmp/src.js of=${TR}/lib/a.js'`,
    // xargs 携带信任根目标
    `echo /tmp/src.js | xargs cp -t ${TR}/lib`,
    `echo /tmp/src.js | xargs -I{} cp {} ${TR}/lib/a.js`,
    `echo /tmp/src.js | xargs -n1 cp -t ${TR}/lib`,
    // node/deno/bun 内联代码里的信任根写入
    `node -e 'require("fs").writeFileSync("${TR}/lib/a.js","x")'`,
    `node --eval 'require("fs").rmSync("${TR}/lib/a.js")'`,
    `deno eval 'Deno.writeTextFile("${TR}/lib/a.js","x")'`,
    `deno eval 'Deno.writeTextFileSync("${TR}/lib/a.js","x")'`,
    `deno eval 'Deno.writeFileSync("${TR}/lib/a.js", new Uint8Array())'`,
    `bun -e 'await Bun.write("${TR}/lib/a.js","x")'`,
    // git 全局选项里的工作树指向信任根
    `git -C ${TR} checkout -- lib/a.js`,
    `git -C ${TR} clean -fd`,
    `git --work-tree=${TR} checkout -- lib/a.js`,
    `git --git-dir ${TR}/.git checkout -- lib/a.js`,
    // 子 shell 分组括号（有无空格、单层与嵌套写法）
    `( cp /tmp/src.js ${TR}/lib/a.js )`,
    `(cp /tmp/src.js ${TR}/lib/a.js)`,
    `( ( cp /tmp/src.js ${TR}/lib/a.js ) )`,
    `{ cp /tmp/src.js ${TR}/lib/a.js; }`,
    // 嵌套：内层命令由外层 shell 执行
    `sh -c "sh -c 'cp /tmp/src.js ${TR}/lib/a.js'"`,
  ];
  for (const command of denied) assert.equal(commandMutatesComposition(command), true, command);
});

test('plain direct trust-root writes keep their existing decision', () => {
  const cases = [
    [`cp /tmp/src.js ${TR}/lib/a.js`, true],
    [`rm -rf ${TR}/lib`, true],
    [`echo x > ${TR}/package.json`, true],
    [`sed -i s/a/b/ ${TR}/lib/a.js`, true],
    [`git checkout -- ${TR}/lib/a.js`, true],
  ];
  for (const [command, expected] of cases) assert.equal(commandMutatesComposition(command), expected, command);
});

test('benign neighbours of the new shapes stay allowed', () => {
  const allowed = [
    // -t / --target-directory 指向普通目录，或从信任根读出
    `cp -t /tmp/out /tmp/src.js`,
    `cp -rt /tmp/out /tmp/src.js`,
    `cp --target-directory /tmp/out /tmp/src.js`,
    `cp -t /tmp/out ${TR}/lib/a.js`,
    // rsync/scp 的 -t 不是目标目录，不能被当成写入目标
    `rsync -t /tmp/src /tmp/dst`,
    `scp -t /tmp/dst`,
    // dd 的 of= 指向普通文件
    `dd if=/dev/zero of=/tmp/image.bin bs=1M count=1`,
    `dd if=${TR}/lib/a.js of=/tmp/copy.bin`,
    // sh -c 内的良性命令与只读访问
    `sh -c 'echo hi > /tmp/log.txt'`,
    `bash -c 'npm test'`,
    `bash -lc 'git -C ${TR} status'`,
    `sh -c 'cat ${TR}/package.json'`,
    `sh -c 'echo "${TR} is protected"'`,
    // xargs 的良性形态
    `echo x | xargs rm -f`,
    `echo x | xargs cp -t /tmp/out`,
    `find . -name '*.log' | xargs rm`,
    `ls | xargs echo done`,
    // node/deno/bun 内联代码的良性形态
    `node -e 'console.log(process.version)'`,
    `node -e 'require("fs").readFileSync("${TR}/package.json")'`,
    `node -p '1 + 1'`,
    `deno eval 'console.log(1)'`,
    // git 全局选项指向普通目录，或子命令本身只读
    `git -C /tmp/repo checkout -b feature`,
    `git -C /tmp/repo clean -fd`,
    `git -C ${TR} status`,
    `git --work-tree=/tmp/repo checkout -- lib/a.js`,
    // 子 shell 分组内的良性命令
    `( cd /tmp && cp a b )`,
    `( ( cat ${TR}/package.json ) )`,
    `{ cd /tmp; cp a b; }`,
    // 既有只读形态
    `cat ${TR}/package.json`,
    `cp ${TR}/lib/a.js /tmp/out.js`,
    `grep -rn cordis ${TR}/lib`,
  ];
  for (const command of allowed) assert.equal(commandMutatesComposition(command), false, command);
});

test('nested shell analysis is bounded and cannot be escaped by deeper nesting', () => {
  const write = `cp /tmp/src.js ${TR}/lib/a.js`;
  const read = `cat ${TR}/package.json`;
  assert.equal(commandMutatesComposition(nestShell(1, write)), true);
  assert.equal(commandMutatesComposition(nestShell(3, write)), true);
  // 超过 MAX_SHELL_NESTING 层后不再逐层解析，但内层同时出现写动词与受保护字样时仍保守拒绝。
  assert.equal(commandMutatesComposition(nestShell(6, write)), true);
  assert.equal(commandMutatesComposition(nestShell(6, read)), false);
});

test('many nested command segments stay linear and keep their decisions', () => {
  const reads = Array.from({ length: 2000 }, () => `sh -c 'cat ${TR}/package.json'`).join(' ; ');
  const writes = Array.from({ length: 2000 }, () => `sh -c 'echo x > ${TR}/lib/a.js'`).join(' ; ');
  assert.equal(commandMutatesComposition(reads), false);
  assert.equal(commandMutatesComposition(writes), true);
});

test('adversarial repetition on the new carriers stays linear', () => {
  // 与 test/security-regression.test.mjs 同样的子进程硬期限：仅靠 node:test 超时
  // 无法中断同步的事件循环卡死。
  const moduleUrl = new URL('../lib/guard.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { commandMutatesComposition } from ${JSON.stringify(moduleUrl)};
    const TR = ${JSON.stringify(TR)};
    const cases = [
      ['cp -t ' + 'x'.repeat(1000000), false],
      ['xargs ' + '-n1 '.repeat(20000) + ' cp -t ' + TR + '/lib', true],
      ['xargs ' + '-n1 '.repeat(20000) + ' cp -t /tmp/out', false],
      ['git ' + '-c k=v '.repeat(20000) + ' checkout -- lib/a.js', false],
      ['git -C ' + TR + ' ' + '-c k=v '.repeat(20000) + ' checkout -- lib/a.js', true],
      ['('.repeat(50000) + ' cp a ' + TR + '/b ' + ')'.repeat(50000), true],
      ['node -e ' + JSON.stringify('writeFileSync('.repeat(20000)), false],
      ['dd ' + 'if=/x '.repeat(50000) + 'of=' + TR + '/f', true],
    ];
    for (const [command, expected] of cases) assert.equal(commandMutatesComposition(command), expected, command.slice(0, 80));
  `], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('inline eval code is judged by write target, not by the mere mention of a trust root', () => {
  const cases = [
    [`require("fs").writeFileSync("${TR}/lib/a.js","x")`, true],
    [`Deno.writeTextFileSync("${TR}/lib/a.js","x")`, true],
    [`require("fs").readFileSync("${TR}/package.json")`, false],
    [`console.log("${TR}")`, false],
    [`const target = "${TR}/lib/a.js"; fs.writeFileSync(target, "x")`, true],
  ];
  for (const [code, expected] of cases) assert.equal(codeMutatesComposition(code), expected, code);
});

test('the pre-execution guard callback denies the same shapes', () => {
  let guard;
  apply({ tools: { guard: (callback) => { guard = callback; } } });
  for (const command of [
    `cp -t ${TR}/lib /tmp/src.js`,
    `dd if=/tmp/src.js of=${TR}/lib/a.js`,
    `sh -c 'cp /tmp/src.js ${TR}/lib/a.js'`,
    `echo /tmp/src.js | xargs cp -t ${TR}/lib`,
    `node -e 'require("fs").writeFileSync("${TR}/lib/a.js","x")'`,
    `git -C ${TR} checkout -- lib/a.js`,
  ]) {
    assert.match(guard({ name: 'bash', arguments: { command } }), /已被拒绝/, command);
  }
  for (const command of [`cp -t /tmp/out /tmp/src.js`, `sh -c 'npm test'`, `git -C ${TR} status`]) {
    assert.equal(guard({ name: 'bash', arguments: { command } }), undefined, command);
  }
});

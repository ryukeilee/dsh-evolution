#!/usr/bin/env node
/** Invoked by the real ACP shell tool, never by the outer acceptance driver.
 * Test-only launch through the previously verified Desktop/profile mechanism.
 * Owns only its isolated Desktop child; restores its temporary probe patch.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const [homeArg, requestArg] = process.argv.slice(2);
if (!homeArg || !requestArg) throw new Error('Usage: run-desktop-task.mjs <isolated-home> <task.json>');
const home = path.resolve(homeArg), request = path.resolve(requestArg);
if (home === path.join(os.homedir(), '.dsh') || !home.startsWith(`${os.tmpdir()}${path.sep}`)) throw new Error('Only a temporary isolated home is allowed');
const patch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
const previous = await fs.readFile(patch, 'utf8');
const probe = new URL('./probes/acp-desktop-task-probe.mjs', import.meta.url).href;
const addition = `\n# isolated ACP-driven Desktop task\n- insert:\n    - id: acp-desktop-task-probe\n      name: '${probe}'\n`;
const launchLock = await fs.open(`${request}.launch`, 'wx', 0o600);
await launchLock.close();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
delete env.ELECTRON_RUN_AS_NODE;
const log = await fs.open(`${request}.desktop.log`, 'w', 0o600);
let child, exit, cancelled = false;
process.once('SIGTERM', () => { cancelled = true; });
process.once('SIGINT', () => { cancelled = true; });
try {
  await fs.writeFile(patch, previous + addition);
  child = spawn('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', [`--user-data-dir=${path.join(home, 'acp-task-electron')}`], {
    cwd: home, env: { ...env, DSH_HOME: home, EVOLUTION_ACP_TASK: request }, stdio: ['ignore', log.fd, log.fd],
  });
  exit = once(child, 'exit');
  const startedAt = Date.now();
  const deadline = startedAt + 32 * 60 * 1000;
  for (;;) {
    let result;
    try { result = JSON.parse(await fs.readFile(`${request}.result.json`, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (result) {
      if (!result.ok) throw new Error(`Desktop task failed: ${result.error}`);
      console.log(JSON.stringify({ ok: true, experimentId: result.experimentId, phase: result.phase, toolName: result.toolName, desktopPid: result.desktopPid }));
      break;
    }
    if (cancelled || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline
      || (Date.now() - startedAt > 90000 && !await fs.stat(`${request}.prepared.json`).catch(() => null))) throw new Error('Desktop task exited or timed out before reporting');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    await exit; clearTimeout(kill);
  }
  await log.close();
  await fs.rm(`${request}.launch`);
  // Preserve a concurrent operator edit instead of replacing it.
  if (await fs.readFile(patch, 'utf8') === previous + addition) await fs.writeFile(patch, previous);
}

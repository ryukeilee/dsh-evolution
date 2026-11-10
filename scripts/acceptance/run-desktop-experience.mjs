#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const [binary, homeArgument, outArgument] = process.argv.slice(2);
if (!binary || !homeArgument || !outArgument) throw new Error('Usage: run-desktop-experience.mjs <Desktop-binary> <isolated-initialized-home> <evidence.json>');
const home = path.resolve(homeArgument);
if (home === path.resolve(process.env.HOME || '', '.dsh')) throw new Error('Refusing formal DSH_HOME');
const patch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
const probe = pathToFileURL(fileURLToPath(new URL('./probes/shared-experience-probe.mjs', import.meta.url))).href;
const marker = '# isolated entry experience probe';
let previous = fs.readFileSync(patch, 'utf8');
if (!previous.includes(marker)) fs.appendFileSync(patch, `\n${marker}\n- insert:\n    - id: entry-experience-probe\n      name: '${probe}'\n`);
const receipt = path.join(home, `desktop-experience-receipt-${randomUUID()}.json`);
const userData = path.join(home, 'electron-experience-test');
const log = fs.openSync(path.join(home, 'desktop-experience.log'), 'w', 0o600);
const env = { ...process.env, DSH_HOME: home, EVOLUTION_ENTRY_PROBE_OUT: receipt };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [`--user-data-dir=${userData}`], { cwd: home, env, stdio: ['ignore', log, log] });
fs.closeSync(log);
let exited = false;
const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
try {
  const deadline = Date.now() + 45000;
  while (!fs.existsSync(receipt) && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!fs.existsSync(receipt)) throw new Error('Desktop did not produce an isolated receipt; inspect its temporary log');
  const evidence = { entry: 'official Desktop application', isolatedElectronUserData: true,
    guiInteractionTested: false, ...JSON.parse(fs.readFileSync(receipt, 'utf8')) };
  fs.mkdirSync(path.dirname(path.resolve(outArgument)), { recursive: true });
  fs.writeFileSync(outArgument, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  if (!exited) child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolve => setTimeout(() => { if (!exited) child.kill('SIGKILL'); resolve(); }, 3000))]);
}

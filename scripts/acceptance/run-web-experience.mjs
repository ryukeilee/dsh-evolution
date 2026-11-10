#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const [cli, homeArgument, outArgument] = process.argv.slice(2);
if (!cli || !homeArgument || !outArgument) throw new Error('Usage: run-web-experience.mjs <official-cli> <isolated-home> <evidence.json>');
const home = path.resolve(homeArgument);
if (home === path.resolve(process.env.HOME || '', '.dsh')) throw new Error('Refusing formal DSH_HOME');
const receipt = path.join(home, `web-experience-${randomUUID()}.json`);
const patch = path.join(home, 'web-experience-probe.yml');
fs.writeFileSync(patch, `- id: hmr\n  disabled: true\n- insert:\n    - id: shared-experience-probe\n      name: '${new URL('./probes/shared-experience-probe.mjs', import.meta.url).href}'\n`);
const log = fs.openSync(path.join(home, 'web-experience.log'), 'w', 0o600);
const child = spawn(cli, ['--profile', 'web', '--patch', patch, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'],
  { cwd: home, env: { ...process.env, DSH_HOME: home, EVOLUTION_ENTRY_PROBE_OUT: receipt }, stdio: ['ignore', log, log] });
fs.closeSync(log);
let exited = false;
const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
try {
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(receipt) && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!fs.existsSync(receipt)) throw new Error('Web did not produce an isolated receipt');
  const evidence = { entry: 'official Web profile', browserInteractionTested: false, ...JSON.parse(fs.readFileSync(receipt, 'utf8')) };
  fs.mkdirSync(path.dirname(path.resolve(outArgument)), { recursive: true });
  fs.writeFileSync(outArgument, `${JSON.stringify(evidence, null, 2)}\n`); console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  if (!exited) child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolve => setTimeout(() => { if (!exited) child.kill('SIGKILL'); resolve(); }, 3000))]);
}

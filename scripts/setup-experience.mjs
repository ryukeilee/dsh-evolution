#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const BEGIN = '# BEGIN dsh-evolution shared experience';
const END = '# END dsh-evolution shared experience';
export function managedPatch(previous, profile) {
  // Official fresh profiles use a flow-style empty list. Appending block
  // entries after `[]` would make invalid YAML. Preserve comments and remove
  // only that empty-list token; refuse other flow documents without rewriting.
  const first = previous.split('\n').find(line => line.trim() && !line.trimStart().startsWith('#'));
  if (first?.trimStart().startsWith('[')) {
    if (!/^\s*\[\]\s*(?:#.*)?$/.test(first)) throw new Error('Flow-style profile patch requires manual conversion to a block list');
    previous = previous.replace(/^(\s*)\[\]([ \t]*(?:#.*)?)$/m, '$1$2');
  }
  const begin = previous.indexOf(BEGIN);
  const end = previous.indexOf(END);
  if ((begin < 0) !== (end < 0) || (begin >= 0 && (end < begin
    || previous.indexOf(BEGIN, begin + BEGIN.length) >= 0 || previous.indexOf(END, end + END.length) >= 0))) {
    throw new Error('Ambiguous managed patch; preserve the file and resolve its markers manually');
  }
  // Official patches replace config wholesale; role selection uses only entry
  // enabled flags, leaving every config (including expressions) intact.
  // Desktop owns the single Evolution kernel and the ACP -> Desktop task host;
  // the ACP profile owns the coordination tool and the promoted-plugin consumer.
  // The Web profile only consumes shared plugins and deliberately mounts neither
  // the kernel nor the ACP control surface.
  const block = `${BEGIN}\n- id: hmr\n  disabled: true\n- id: evolution-experience\n  disabled: false\n- id: evolution-experience-history\n  disabled: ${profile === 'desktop'}\n- id: evolution-orchestrator\n  disabled: ${profile !== 'desktop'}\n- id: evolution-promoted-consumer\n  disabled: ${profile === 'desktop'}\n- id: evolution-desktop-task-host\n  disabled: ${profile !== 'desktop'}\n- id: evolution-desktop-task-client\n  disabled: ${profile !== 'acp'}\n${END}`;
  return begin < 0 ? previous + (previous.endsWith('\n') || !previous ? '' : '\n') + block + '\n'
    : previous.slice(0, begin) + block + previous.slice(end + END.length);
}

export function setupPlan({ home, tarball, cli }) {
  if (!path.isAbsolute(home) || !path.isAbsolute(tarball)) throw new Error('Absolute home and tarball paths required');
  if (!fs.statSync(tarball).isFile()) throw new Error('Tarball required');
  const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  // A file dependency is cached by path. Rebuilding the same development
  // filename must not be mistaken for an already installed older package.
  const artifact = path.join(home, 'storages', 'evolution-package-cache', `${sha256}.tgz`);
  return ['desktop', 'acp', 'web'].map(profile => {
    const file = path.join(home, 'profiles', profile, 'cordis.patch.yml');
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { profile, file, previous, next: managedPatch(previous, profile),
      command: cli, args: ['plugin', '--profile', profile, 'add', artifact], artifact, sha256,
      role: profile === 'desktop' ? 'existing manual Evolution + shared collection/recall' : 'shared collection/recall + promoted-plugin consumer' };
  });
}

function main(argv) {
  const options = { home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (['--home', '--tarball', '--cli'].includes(arg) && argv[i + 1]) options[arg.slice(2)] = argv[++i];
    else throw new Error('Usage: dsh-evolution-setup --tarball <package.tgz> [--home <DSH_HOME>] [--cli <official dsh>] [--apply]');
  }
  if (!options.tarball) throw new Error('--tarball is required; this command never publishes a release');
  const desktopCli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  options.cli ||= fs.existsSync(desktopCli) ? desktopCli : 'dsh';
  const home = path.resolve(options.home);
  const plan = setupPlan({ ...options, home, tarball: path.resolve(options.tarball) });
  console.log(JSON.stringify({ apply: options.apply, home, profiles: plan.map(({ profile, file, role, command, args }) => ({ profile, file, role, command, args })) }, null, 2));
  if (!options.apply) return;
  const bytes = fs.readFileSync(path.resolve(options.tarball));
  if (createHash('sha256').update(bytes).digest('hex') !== plan[0].sha256) throw new Error('Package changed after planning; nothing installed');
  const artifact = plan[0].artifact;
  fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(artifact, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.readFileSync(artifact).equals(bytes)) throw new Error('Cached package disagrees with its digest; preserving it for inspection');
  // Official plugin management owns dependency registration. Apply each owned
  // override only after success; report partial progress instead of pretending
  // a multi-profile install is an atomic DSH transaction.
  for (const item of plan) {
    const result = spawnSync(item.command, item.args, { env: { ...process.env, DSH_HOME: home }, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Installation stopped at ${item.profile}; previous profiles remain installed`);
    const current = fs.existsSync(item.file) ? fs.readFileSync(item.file, 'utf8') : '';
    // The official CLI may create the profile's stock patch on first install.
    // Recompute over that file, preserving its contents and all user entries.
    const temporary = `${item.file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, managedPatch(current, item.profile)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, item.file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(item.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    console.log(`${item.profile}: configured; restart this entry to apply (HMR disabled)`);
  }
}

const isEntryPoint = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isEntryPoint) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

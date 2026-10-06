#!/usr/bin/env node
/**
 * dsh-evolution doctor — model-free diagnostics.
 *
 * Reads the installed package, the resolved DSH host, the composed profile, the
 * Evolution data root, the domain aggregate, the migration manifest, and the
 * promotion journal. It never calls a model, never uploads anything, and writes
 * only when --repair is passed (and only for states with a provably safe,
 * idempotent rollback).
 *
 * Usage:
 *   node scripts/doctor.mjs [--home <DSH_HOME>] [--profile <name>] [--data-root <dir>]
 *                           [--dsh-cli <path>] [--json] [--repair] [--no-composition]
 *
 * Exit codes: 0 healthy, 1 degraded, 2 blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDiagnostics, runDiagnostics, summarize, exitCodeFor, resolveEvolutionPaths, PACKAGE_ROOT } from '../lib/diagnostics.js';

function parseArgs(argv) {
  const options = { json: false, repair: false, composition: true, quiet: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--home') options.home = value();
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--data-root') options.dataRoot = value();
    else if (arg === '--dsh-cli') options.cliPath = value();
    else if (arg === '--json') options.json = true;
    else if (arg === '--repair') options.repair = true;
    else if (arg === '--no-composition') options.composition = false;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Pick the profile that actually lists this bundle, without guessing. */
export function detectProfile({ dshHome, requested }) {
  const profilesDir = path.join(dshHome, 'profiles');
  if (!fs.existsSync(profilesDir)) return { profile: requested || null, source: requested ? 'argument' : 'no-profiles-directory', candidates: [] };
  const candidates = fs.readdirSync(profilesDir).filter((name) => fs.existsSync(path.join(profilesDir, name, 'package.json'))).sort();
  const withBundle = [];
  for (const name of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(profilesDir, name, 'package.json'), 'utf8'));
      if ((manifest?.dsh?.profile?.bundles || []).includes('dsh-evolution')) withBundle.push(name);
    } catch { /* an unreadable profile is reported by the install check */ }
  }
  if (requested) return { profile: requested, source: 'argument', candidates, withBundle };
  if (withBundle.length > 0) return { profile: withBundle[0], source: withBundle.length === 1 ? 'detected' : 'detected-first-of-several', candidates, withBundle };
  return { profile: null, source: 'no-profile-lists-dsh-evolution', candidates, withBundle };
}

const HELP = `dsh-evolution doctor

  --home <dir>        DSH_HOME to diagnose (default: $DSH_HOME or ~/.dsh)
  --profile <name>    profile to inspect (default: the profile that lists dsh-evolution)
  --data-root <dir>   override the Evolution data root
  --dsh-cli <path>    path to @deepseek-ai/dsh/lib/bin.js used to compose the profile
  --json              print the machine-readable report
  --repair            apply only safe, idempotent repairs, then re-verify
  --no-composition    skip the official --dump-config composition probe
  --quiet             print only the status line
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return 0; }
  const home = path.resolve(options.home || process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh'));
  const detected = detectProfile({ dshHome: home, requested: options.profile });
  const paths = resolveEvolutionPaths({ dshHome: home, dataRoot: options.dataRoot });
  const report = await (options.repair ? runDiagnostics : collectDiagnostics)({
    dshHome: home,
    home: true,
    profile: detected.profile,
    profileCandidates: detected.candidates,
    paths,
    cliPath: options.cliPath,
    repair: options.repair,
    probe: options.composition ? undefined : { skipComposition: true },
  });
  report.detection = detected;
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (options.quiet) process.stdout.write(`${report.status}\n`);
  else process.stdout.write(`${summarize(report)}\n`);
  return exitCodeFor(report);
}

const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`doctor failed: ${error?.stack || error}\n`);
    process.exitCode = 3;
  });
}

export { HELP, PACKAGE_ROOT, main };

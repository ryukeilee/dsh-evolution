#!/usr/bin/env node
/**
 * Revalidate published stable plugins on the DSH host this data root now runs on.
 *
 * A host upgrade (for example 0.2.2-rc.2 -> 0.2.2-rc.3) leaves every published
 * record in 'pending-revalidation': the record was verified on another exact
 * host, so no consumer may mount it. 'dsh-evolution-shared revalidate' adopts
 * evidence, but nothing in the shipped bundle produces that evidence for a
 * record that is *already* pending, so an operator had to build it by hand.
 * This runner closes that gap with the same toolchain the acceptance runs use:
 * it clones the data root, boots the real ACP and Web consumer entries on the
 * current host, proves each pending record mounts and that its tools are
 * callable, writes schema-1 cross-entry evidence, and (with --apply) adopts it
 * through the official operator command.
 *
 * What it never does:
 *   - it never boots the source home: every consumer process runs against the
 *     throw-away clone, and the source home is only read plus, with --apply,
 *     written by the official revalidation command itself;
 *   - it never edits, regenerates or promotes a plugin source; the source
 *     digest of every record is re-hashed and must still match the index;
 *   - it never lowers a gate: the clone is the only place the "already verified
 *     on this exact host" eligibility is assumed, every proof is a real mount
 *     plus a real tool call, and the evidence records exactly that;
 *   - when the index changes while it runs, it refuses to adopt anything.
 *
 * Usage:
 *   node scripts/acceptance/run-revalidation.mjs --home ~/.dsh [--apply]
 *     [--out <evidence.json>] [--plan <plans.json>] [--work <dir>] [--keep]
 *     [--cli <dsh>] [--timeout-ms <n>] [--json]
 *
 * Exit codes: 0 success (including "nothing to revalidate"), 1 refused/failed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostCompatible, hostDigest, isDisabledForProfile, readDisableState } from '../../lib/promoted-sharing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PROBE = path.join(HERE, 'probes', 'cross-entry-consumer-probe.mjs');
const DEFAULT_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const DEFAULT_PLANS = path.join(HERE, 'revalidation-plans.json');
const PROFILES = Object.freeze(['acp', 'web']);
const CONSUMER_STATE = path.join('storages', 'evolution', 'shared-plugins', 'consumers');
const PUBLISHED_REL = path.join('storages', 'evolution', 'shared-plugins', 'published.json');

export function parseArgs(argv) {
  const options = { apply: false, keep: false, json: false, help: false, timeoutMs: 120000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(arg + ' requires a value');
      index += 1;
      return next;
    };
    if (arg === '--home') options.home = path.resolve(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--plan') options.plan = path.resolve(value());
    else if (arg === '--work') options.work = path.resolve(value());
    else if (arg === '--cli') options.cli = path.resolve(value());
    else if (arg === '--shared-script') options.sharedScript = path.resolve(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  return options;
}

export const HELP = [
  'dsh-evolution revalidation runner',
  '',
  '  node scripts/acceptance/run-revalidation.mjs --home <DSH_HOME> [--apply]',
  '',
  'Options:',
  '  --home <dir>          data root whose pending-revalidation records are verified',
  '  --apply               adopt the evidence with dsh-evolution-shared revalidate --evidence <file>',
  '  --out <file>          evidence path (default: docs/evidence/revalidation-<host>-<date>.json)',
  '  --plan <file>         per-record tool-call plan (default: scripts/acceptance/revalidation-plans.json)',
  '  --work <dir>          scratch directory to keep on disk (default: a temporary directory)',
  '  --cli <dsh>           the dsh CLI to boot (default: the installed Desktop runtime)',
  '  --shared-script <f>   shared-plugins.mjs to adopt with (default: the data root own copy)',
  '  --timeout-ms <n>      per consumer boot timeout (default 120000)',
  '  --keep                keep the scratch directory after success',
  '  --json                print one JSON document instead of a summary',
  '',
].join('\n');

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(file + ' is unreadable: ' + String(error && error.message || error));
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** The sidecar that carries adoption proofs, next to the attested evidence. */
export function adoptionReportPath(evidenceFile) {
  return evidenceFile.endsWith('.json') ? evidenceFile.slice(0, -'.json'.length) + '.report.json' : evidenceFile + '.report.json';
}

/**
 * Write the adoption report without touching the evidence file: the operator
 * command records the evidence digest in the publication index, so rewriting
 * that file after adoption would break the only durable provenance link.
 */
export function writeAdoptionReport(evidenceFile, document) {
  const file = adoptionReportPath(evidenceFile);
  writeJsonFile(file, document);
  return file;
}

/**
 * The clone-side index: the same records, with the module URL moved into the
 * clone (a record path outside its own data root is invalid by design) and,
 * for the records under verification only, the exact current host facts that
 * make them eligible in the throw-away clone. Nothing here is written back to
 * the source home.
 */
export function rewriteIndexForVerification(index, options) {
  const settings = options || {};
  const dataRoot = settings.dataRoot;
  const host = settings.host || null;
  const targetIds = new Set(Array.isArray(settings.targets) ? settings.targets : []);
  const at = typeof settings.now === 'string' ? settings.now : new Date().toISOString();
  const next = JSON.parse(JSON.stringify(index));
  const records = Array.isArray(next.plugins) ? next.plugins : [];
  for (const record of records) {
    if (record && typeof record.pluginName === 'string') {
      record.moduleUrl = pathToFileURL(path.join(dataRoot, 'promoted', record.pluginName, 'lib', 'index.js')).href;
    }
    // The evidence clone proves bytes and host, not the current operator
    // supersession topology: leaving a marker here would suppress a superseded
    // target and make it impossible to gather its own activation evidence.
    // The post-adoption clone keeps the markers to verify the final topology.
    if (settings.stripSupersession !== false && record && record.supersededBy) delete record.supersededBy;
    if (host && record && targetIds.has(record.id)) {
      record.host = Object.assign({}, record.host, { dsh: host.dsh, cordis: host.cordis, include: host.include, node: host.node, verifiedAt: at });
    }
  }
  next.updatedAt = at;
  return next;
}

/** The per-record tool-call plan, with $WORK expanded in string arguments. */
/**
 * A profile is a verification target only while it is approved and not
 * explicitly revoked. Revocation is checked at every stage (verification
 * expectations, evidence assembly and post-adoption verification); checking it
 * only when selecting targets leaves a partially revoked record asking a
 * disabled consumer to report `active` and aborts the whole adoption chain.
 */
export function profileIsRevalidationTarget(record, profile, disable) {
  return Array.isArray(record?.approvedProfiles)
    && record.approvedProfiles.includes(profile)
    && !isDisabledForProfile(disable, record.id, profile);
}

/**
 * A record legitimately superseded in this profile is expected to stay
 * `disabled / superseded-by` after the host upgrade: the consumer mounts only
 * the replacement. Requiring `active` on both aborts revalidation for a valid
 * switch. If the replacement is no longer a target, the old record is expected
 * to be active again, which is exactly the recovery the consumer performs.
 */
export function expectedRecordStatus(record, profile, records, disable) {
  const marker = record?.supersededBy?.[profile];
  if (marker) {
    const replacement = (records || []).find((row) => row.id === marker.recordId && profileIsRevalidationTarget(row, profile, disable));
    if (replacement && replacement.sourceSha256 === marker.sourceSha256) {
      return { status: 'disabled', reason: 'superseded-by' };
    }
  }
  return { status: 'active' };
}

export function planFor(plans, recordId, work) {
  const plan = plans && plans.plans ? plans.plans[recordId] : null;
  if (!plan) return null;
  if (typeof plan.tool !== 'string' || plan.tool === '') throw new Error('the plan for ' + recordId + ' has no tool');
  const expand = (value) => {
    if (typeof value === 'string') return value.split('$WORK').join(work);
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map((entry) => [entry[0], expand(entry[1])]));
    return value;
  };
  return { tool: plan.tool, arguments: expand(plan.arguments || {}), expect: plan.expect || null };
}

/** Deterministic tiny git repository used to call a read-only tool for real. */
export function writeGitFixture(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'README.md'), 'revalidation fixture: readonly_git_file returns this line at HEAD\n');
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('git fixture: ' + command + ' ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout));
  };
  run('git', ['init', '--quiet']);
  run('git', ['add', 'README.md']);
  run('git', ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=acceptance', 'commit', '--quiet', '-m', 'revalidation fixture']);
  return directory;
}

export function cloneHome(source, destination) {
  const probe = spawnSync('cp', ['-cR', source, destination], { encoding: 'utf8' });
  if (probe.status !== 0) {
    // Non-APFS filesystems have no clonefile: fall back to a recursive copy.
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
  normalizeSymlinks(destination, source);
}

/**
 * A relative profile link (`dsh-context7-mcp -> ../../../../.local/share/...`)
 * is anchored at the home's parent, so resolving it inside the clone would
 * point at the scratch tree and leave the bundle unresolvable. Anchor every
 * relative link at the same place it resolves to in the source home instead,
 * which is what a real profile start would load (read-only).
 */
export function normalizeSymlinks(root, sourceRoot = root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const relative = path.relative(root, file);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      if (!path.isAbsolute(target)) {
        const sourceDirectory = path.dirname(path.join(sourceRoot, relative));
        const resolved = path.resolve(sourceDirectory, target);
        fs.unlinkSync(file);
        fs.symlinkSync(resolved, file);
      }
    } else if (entry.isDirectory()) {
      normalizeSymlinks(file, path.join(sourceRoot, relative));
    }
  }
}

function treeDigest(root, options) {
  const exclude = options && Array.isArray(options.exclude) ? options.exclude : [];
  const rows = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const rel = path.relative(root, file);
      if (exclude.some((prefix) => rel === prefix || rel.startsWith(prefix + path.sep))) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) rows.push([rel, sha256File(file)]);
    }
  };
  walk(root);
  return sha256(JSON.stringify(rows.sort()));
}

async function experienceRows(dshHome) {
  const file = path.join(dshHome, 'storages', 'evolution-experience', 'experience.sqlite');
  if (!fs.existsSync(file)) return null;
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      return Object.fromEntries(tables.map((table) => {
        try {
          const quoted = String(table).replaceAll('"', '""');
          return [table, db.prepare('SELECT COUNT(*) AS n FROM "' + quoted + '"').get().n];
        } catch {
          return [table, null];
        }
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    return { unavailable: String(error && error.code || error && error.message || error) };
  }
}

/**
 * Boot one real consumer entry against the clone and wait for the probe receipt.
 * The source home is rejected here as well, so a wrong caller cannot make the
 * runner exercise production.
 */
function bootConsumer(input) {
  const profile = input.profile;
  const home = input.cloneHome;
  if (path.resolve(home) === path.resolve(input.sourceHome)) throw new Error('refusing to boot the source DSH_HOME');
  const patchFile = path.join(input.work, input.label + '.patch.yml');
  fs.writeFileSync(patchFile, "- insert:\n    - id: revalidation-" + input.label + "\n      name: '" + pathToFileURL(PROBE).href + "'\n");
  const receipt = path.join(input.work, input.label + '.receipt.json');
  const bootAfter = new Date().toISOString();
  const env = Object.assign(
    Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith('DSH_'))),
    {
      DSH_HOME: home,
      EVOLUTION_ENTRY_PROBE_OUT: receipt,
      EVOLUTION_CROSS_ENTRY_PROFILE: profile,
      EVOLUTION_CROSS_ENTRY_EXPECT: JSON.stringify(input.expect || {}),
      EVOLUTION_CROSS_ENTRY_BOOT_AFTER: bootAfter,
      EVOLUTION_ACCEPTANCE_CWD: input.cwd,
    },
  );
  if (input.toolCalls) env.EVOLUTION_CROSS_ENTRY_TOOL_CALLS = JSON.stringify(input.toolCalls);
  const args = profile === 'acp'
    ? ['--profile', 'acp', '--patch', patchFile]
    : ['--profile', 'web', '--patch', patchFile, '--', '--no-open', '--host', '127.0.0.1', '--port', '0'];
  return new Promise((resolve) => {
    const child = spawn(input.cli, args, { cwd: home, env, stdio: [profile === 'acp' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let text = '';
    let settled = false;
    let poll = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fs.writeFileSync(path.join(input.logs, input.label + '.log'), text);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      const exited = () => resolve(Object.assign({}, value, { log: text }));
      if (child.exitCode !== null || child.signalCode !== null) { exited(); return; }
      child.once('exit', exited);
      setTimeout(exited, 5000).unref();
    };
    const timer = setTimeout(() => finish({ error: input.label + ' timed out after ' + input.timeoutMs + ' ms' }), input.timeoutMs);
    child.stdout.on('data', (bytes) => { text += bytes.toString(); });
    child.stderr.on('data', (bytes) => { text += bytes.toString(); });
    child.on('error', (error) => finish({ error: input.label + ' could not start: ' + String(error && error.message || error) }));
    if (profile === 'acp') {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
      } catch {
        // reported by the timeout
      }
    }
    poll = setInterval(() => {
      if (!fs.existsSync(receipt)) return;
      const value = readJsonFile(receipt);
      if (!value) return;
      finish(value.ok === false ? { error: value.error } : { result: value });
    }, 200);
  });
}

function rowsById(state) {
  return new Map((state && Array.isArray(state.plugins) ? state.plugins : []).map((row) => [row && row.id, row]));
}

export function redact(value, home, work) {
  const json = JSON.stringify(value)
    .split(JSON.stringify(home).slice(1, -1)).join('$DSH_HOME')
    .split(JSON.stringify(work).slice(1, -1)).join('<work>')
    .split(JSON.stringify(REPO_ROOT).slice(1, -1)).join('<repo>');
  return JSON.parse(json);
}

export function checkToolExpectation(call) {
  if (call.isError === true) return 'tool ' + call.name + ' reported an error: ' + String(call.text).slice(0, 400);
  let parsed;
  try { parsed = JSON.parse(call.text); } catch { parsed = undefined; }
  const expect = call.expect;
  if (!expect) return null;
  if (typeof expect.contains === 'string' && !String(call.text).includes(expect.contains)) {
    return 'tool ' + call.name + ' output does not contain ' + JSON.stringify(expect.contains) + ': ' + String(call.text).slice(0, 400);
  }
  if (expect.json && typeof expect.json === 'object') {
    if (!parsed || typeof parsed !== 'object') return 'tool ' + call.name + ' output is not JSON';
    for (const entry of Object.entries(expect.json)) {
      const got = parsed[entry[0]];
      if (JSON.stringify(got) !== JSON.stringify(entry[1])) {
        return 'tool ' + call.name + ' returned ' + entry[0] + '=' + JSON.stringify(got) + ', expected ' + JSON.stringify(entry[1]);
      }
    }
  }
  return null;
}

function hostFactsOf(state, profile) {
  const host = state && state.host;
  if (!host) throw new Error('the ' + profile + ' consumer did not record its host facts');
  return { dsh: host.dsh, cordis: host.cordis, include: host.include, node: host.node };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.home) {
    process.stdout.write(HELP);
    return options.help ? 0 : 1;
  }
  const sourceHome = options.home;
  const indexPath = path.join(sourceHome, PUBLISHED_REL);
  if (!fs.existsSync(indexPath)) throw new Error(sourceHome + ' has no published plugin index (' + indexPath + ')');
  const cli = options.cli || DEFAULT_CLI;
  if (!fs.existsSync(cli)) throw new Error('the dsh CLI is not installed at ' + cli);
  const plans = readJsonFile(options.plan || DEFAULT_PLANS);
  const startedAt = new Date().toISOString();
  const work = options.work || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-revalidation-'));
  fs.mkdirSync(path.join(work, 'logs'), { recursive: true });
  const logs = path.join(work, 'logs');

  const indexBytes = fs.readFileSync(indexPath);
  const indexDigestBefore = sha256(indexBytes);
  const index = JSON.parse(indexBytes);
  const records = Array.isArray(index.plugins) ? index.plugins : [];
  if (records.length === 0) {
    console.log('nothing to revalidate: the publication index has no records');
    return 0;
  }

  const evolutionBefore = treeDigest(path.join(sourceHome, 'storages', 'evolution'), { exclude: ['shared-plugins'] });
  const experienceBefore = await experienceRows(sourceHome);

  // 1. Clone the data root and point every record module URL into the clone.
  //    A boot of this clone reports the exact host facts the consumers capture.
  const clone = path.join(work, 'verify-home');
  cloneHome(sourceHome, clone);
  const cloneDataRoot = path.join(clone, 'storages', 'evolution');
  const cloneIndexPath = path.join(clone, PUBLISHED_REL);
  writeJsonFile(cloneIndexPath, rewriteIndexForVerification(index, { dataRoot: cloneDataRoot, host: null, targets: [] }));

  // 2. Baseline boot per profile: no expectations, so the consumers report what
  //    they really did with every record and capture their own host facts.
  const factsByProfile = {};
  for (const profile of PROFILES) {
    const outcome = await bootConsumer({
      profile,
      cloneHome: clone,
      expect: {},
      toolCalls: null,
      label: 'baseline-' + profile,
      work,
      logs,
      cli,
      timeoutMs: options.timeoutMs,
      sourceHome,
      cwd: work,
    });
    if (outcome.error) throw new Error('the baseline ' + profile + ' consumer boot failed: ' + outcome.error);
    factsByProfile[profile] = hostFactsOf(readJsonFile(path.join(clone, CONSUMER_STATE, profile + '.json')), profile);
  }
  const host = {
    dsh: factsByProfile.acp.dsh,
    cordis: factsByProfile.acp.cordis,
    include: factsByProfile.acp.include,
    node: factsByProfile.acp.node,
  };
  for (const profile of PROFILES) {
    for (const field of ['dsh', 'cordis', 'include']) {
      if (factsByProfile[profile][field] !== host[field]) {
        throw new Error('the ' + profile + ' consumer runs on ' + field + ' ' + factsByProfile[profile][field] + ', the acp consumer on ' + host[field]);
      }
    }
    if (String(factsByProfile[profile].node).split('.')[0] !== String(host.node).split('.')[0]) {
      throw new Error('the ' + profile + ' consumer runs on Node ' + factsByProfile[profile].node + ', the acp consumer on ' + host.node);
    }
  }

  // 3. Every record a consumer reports as pending-revalidation on this host is a
  //    revalidation target. Anything else is reported, never silently adopted.
  //    A record revoked on every approved profile is out of scope: it can never
  //    be a live revalidation target, but its host mismatch must not abort the
  //    evidence run for the records that are still active.
  const disable = await readDisableState({ dataRoot: cloneDataRoot });
  const skippedRevokedIds = records.filter((record) => record.approvedProfiles.length > 0
    && record.approvedProfiles.every((profile) => isDisabledForProfile(disable, record.id, profile)))
    .map((record) => record.id);
  const activeRecords = records.filter((record) => !skippedRevokedIds.includes(record.id));
  const pending = new Map();
  for (const profile of PROFILES) {
    const rows = rowsById(readJsonFile(path.join(clone, CONSUMER_STATE, profile + '.json')));
    for (const record of activeRecords) {
      const row = rows.get(record.id);
      if (!row) continue;
      // A consumer marks a record pending-revalidation when its own host facts
      // do not match the record, whatever the specific mismatching component
      // (DSH, Cordis, Include or Node). Accept the status itself; the source
      // digest, activation proof and adoption gates below stay unchanged.
      if (row.status === 'pending-revalidation') {
        if (!pending.has(record.id)) pending.set(record.id, {});
        pending.get(record.id)[profile] = { status: row.status, reason: row.reason, hostDigest: row.hostDigest || null };
      }
    }
  }
  for (const record of activeRecords) {
    if (pending.has(record.id)) continue;
    const current = hostCompatible(record.host, host);
    if (current.ok) continue;
    throw new Error(record.id + ' is not compatible with this host (' + current.reason + ') but no consumer reported it pending; investigate before revalidating');
  }
  const targets = [...pending.keys()].filter((id) => {
    const rows = pending.get(id);
    return Boolean(rows.acp || rows.web);
  });
  if (targets.length === 0) {
    console.log('nothing to revalidate: every published record is eligible on this host');
    return 0;
  }

  // 4. Re-hash every target source bytes: adoption must never attest different
  //    code than the record published.
  const promotedRoot = path.join(cloneDataRoot, 'promoted');
  for (const id of targets) {
    const record = records.find((row) => row.id === id);
    const file = path.join(promotedRoot, record.pluginName, 'lib', 'index.js');
    const digest = sha256File(file);
    if (digest !== record.sourceSha256) throw new Error(id + ' source digest is ' + digest + ', not the published ' + record.sourceSha256);
  }

  // 5. Verify on the clone with the current host facts: one real boot per
  //    profile, and each planned tool call through the official executor.
  const verificationIndex = rewriteIndexForVerification(index, { dataRoot: cloneDataRoot, host, targets });
  writeJsonFile(cloneIndexPath, verificationIndex);
  const verificationRecords = Array.isArray(verificationIndex.plugins) ? verificationIndex.plugins : [];
  const plansByRecord = new Map(targets.map((id) => [id, planFor(plans, id, work)]));
  for (const plan of plansByRecord.values()) {
    if (plan && plan.tool === 'readonly_git_file') writeGitFixture(path.join(work, 'git-fixture'));
  }
  const verification = {};
  for (const profile of PROFILES) {
    const expect = {};
    const calls = [];
    for (const id of targets) {
      const record = records.find((row) => row.id === id);
      if (!profileIsRevalidationTarget(record, profile, disable)) continue;
      const verificationRecord = verificationRecords.find((row) => row.id === id) ?? record;
      expect[id] = expectedRecordStatus(verificationRecord, profile, verificationRecords, disable);
      const plan = plansByRecord.get(id);
      if (plan && expect[id].status === 'active') {
        calls.push({ id: id + ':' + plan.tool, name: plan.tool, arguments: plan.arguments, expect: plan.expect, recordId: id });
      }
    }
    const outcome = await bootConsumer({
      profile,
      cloneHome: clone,
      expect,
      toolCalls: calls.length > 0 ? calls : null,
      label: 'verify-' + profile,
      work,
      logs,
      cli,
      timeoutMs: options.timeoutMs,
      sourceHome,
      cwd: work,
    });
    if (outcome.error) throw new Error('the verification ' + profile + ' consumer boot failed: ' + outcome.error);
    for (const call of outcome.result.toolCalls || []) {
      const failure = checkToolExpectation(call);
      if (failure) throw new Error(failure);
    }
    const state = readJsonFile(path.join(clone, CONSUMER_STATE, profile + '.json'));
    verification[profile] = { result: outcome.result, rows: rowsById(state), expectedHostDigest: hostDigest(host) };
  }

  // 6. Assemble the evidence: exact host identity, exact source digest and one
  //    activation proof per approved profile, plus the real tool calls.
  const plugins = [];
  for (const id of targets) {
    const record = records.find((row) => row.id === id);
    const profiles = {};
    for (const profile of PROFILES) {
      if (!profileIsRevalidationTarget(record, profile, disable)) continue;
      const row = verification[profile].rows.get(id);
      const verificationRecord = verificationRecords.find((row) => row.id === id) ?? record;
      const expectedStatus = expectedRecordStatus(verificationRecord, profile, verificationRecords, disable);
      if (!row || row.status !== expectedStatus.status
        || (expectedStatus.reason && row.reason !== expectedStatus.reason)) {
        throw new Error(id + ' is ' + (row ? `${row.status}/${row.reason}` : 'missing') + ' in the verified ' + profile + ' entry');
      }
      if (row.sourceSha256 !== record.sourceSha256) throw new Error('the ' + profile + ' entry activated a different source for ' + id);
      if (row.hostDigest !== verification[profile].expectedHostDigest) {
        throw new Error('the ' + profile + ' entry activated ' + id + ' on host digest ' + row.hostDigest + ', not the captured ' + verification[profile].expectedHostDigest);
      }
      const calls = (verification[profile].result.toolCalls || []).filter((call) => String(call.id).startsWith(id + ':'));
      profiles[profile] = {
        active: true,
        activatedAt: row.activatedAt || null,
        hostDigest: row.hostDigest || null,
        toolNames: verification[profile].result.toolNames || [],
        toolCalls: calls.map((call) => ({ id: call.id, name: call.name, path: call.path || null, isError: call.isError, code: call.code || null, text: call.text })),
      };
    }
    if (Object.keys(profiles).length === 0) throw new Error(id + ' has no approved consumer profile');
    plugins.push({
      id,
      experimentId: record.experimentId,
      sourceSha256: record.sourceSha256,
      approvedProfiles: record.approvedProfiles,
      previousHost: record.host,
      profiles,
    });
  }
  if (plugins.length !== targets.length) throw new Error('the evidence does not cover every revalidation target');

  const evidenceFile = options.out || path.join(REPO_ROOT, 'docs', 'evidence', 'revalidation-' + host.dsh + '-' + startedAt.slice(0, 10).replaceAll('-', '') + '.json');
  const evidence = {
    schemaVersion: 1,
    kind: 'dsh-evolution-cross-entry-evidence',
    runner: {
      name: 'dsh-evolution-revalidation',
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform + '-' + process.arch,
      cli,
      probe: PROBE,
    },
    host: { dsh: host.dsh, cordis: host.cordis, include: host.include, node: host.node },
    source: {
      indexPath: path.join('$DSH_HOME', PUBLISHED_REL),
      indexDigestBefore,
      indexUpdatedAt: index.updatedAt || null,
      recordCount: records.length,
      skippedRevokedIds,
    },
    // The clone is the only place the record recorded host is replaced by the
    // current one; every activation below is a real boot of the real entry.
    verification: {
      method: 'isolated-clone-current-host-eligibility',
      note: 'the cloned record host was rewritten to the host facts captured by the baseline consumer boot; the source home was never rewritten',
      targetIds: targets,
    },
    profiles: Object.fromEntries(PROFILES.map((profile) => [profile, {
      consumerStateHost: factsByProfile[profile],
      verifiedRows: verification[profile].result.rows || [],
      kernelPresent: verification[profile].result.kernelPresent === true,
      evolutionToolNames: verification[profile].result.evolutionToolNames || [],
      tools: verification[profile].result.toolNames || [],
    }])),
    plugins,
  };
  writeJsonFile(evidenceFile, redact(evidence, sourceHome, work));
  // The evidence file is the artifact the operator command digests and records
  // in the publication index, so it must stay byte-identical from here on. The
  // adoption and post-adoption proofs are written next to it instead.
  const evidenceSha256 = sha256File(evidenceFile);

  // 7. Adopt through the official operator command, then prove a byte-identical
  //    clone of the updated home mounts the records with no eligibility rewrite:
  //    that is the real end state the source home boots into next time.
  let adoption = null;
  let postAdoption = null;
  let adoptionReportFile = null;
  if (options.apply) {
    const currentBytes = fs.readFileSync(indexPath);
    if (sha256(currentBytes) !== indexDigestBefore) throw new Error('the publication index changed while verification ran; refusing to adopt');
    const profileScript = path.join(sourceHome, 'profiles', 'acp', 'node_modules', 'dsh-evolution', 'scripts', 'shared-plugins.mjs');
    const sharedScript = options.sharedScript || (fs.existsSync(profileScript) ? profileScript : path.join(REPO_ROOT, 'scripts', 'shared-plugins.mjs'));
    const adopted = spawnSync(process.execPath, [sharedScript, 'revalidate', '--home', sourceHome, '--evidence', evidenceFile, '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { DSH_HOME: sourceHome }) });
    if (adopted.status !== 0) throw new Error('the revalidation was refused: ' + String(adopted.stderr || adopted.stdout).slice(-2000));
    adoption = { command: 'dsh-evolution-shared revalidate --home $DSH_HOME --evidence <this file>', script: sharedScript, result: JSON.parse(adopted.stdout) };
    if (adoption.result?.evidenceSha256 !== evidenceSha256) {
      throw new Error('the operator command adopted evidence digest ' + String(adoption.result?.evidenceSha256) + ', the runner wrote ' + evidenceSha256);
    }
    const updated = readJsonFile(indexPath);
    for (const plugin of plugins) {
      const record = updated.plugins.find((row) => row.id === plugin.id);
      if (!record) throw new Error(plugin.id + ' disappeared from the index after adoption');
      if (!record.host || record.host.dsh !== host.dsh) throw new Error(plugin.id + ' was not adopted on DSH ' + host.dsh);
      if (!Array.isArray(record.revalidation) || record.revalidation.length === 0) throw new Error(plugin.id + ' has no revalidation generation after adoption');
    }
    const clone2 = path.join(work, 'adopted-home');
    cloneHome(sourceHome, clone2);
    const clone2DataRoot = path.join(clone2, 'storages', 'evolution');
    const adoptedIndex = rewriteIndexForVerification(readJsonFile(indexPath), {
      dataRoot: clone2DataRoot, host: null, targets: [], stripSupersession: false,
    });
    writeJsonFile(path.join(clone2, PUBLISHED_REL), adoptedIndex);
    const adoptedRecords = Array.isArray(adoptedIndex.plugins) ? adoptedIndex.plugins : [];
    postAdoption = {};
    for (const profile of PROFILES) {
      const expect = {};
      const calls = [];
      for (const plugin of plugins) {
        if (!profileIsRevalidationTarget(plugin, profile, disable)) continue;
        const adoptedRecord = adoptedRecords.find((row) => row.id === plugin.id) ?? plugin;
        expect[plugin.id] = expectedRecordStatus(adoptedRecord, profile, adoptedRecords, disable);
        const plan = plansByRecord.get(plugin.id);
        if (plan && expect[plugin.id].status === 'active') {
          calls.push({ id: plugin.id + ':' + plan.tool, name: plan.tool, arguments: plan.arguments, expect: plan.expect, recordId: plugin.id });
        }
      }
      const outcome = await bootConsumer({
        profile,
        cloneHome: clone2,
        expect,
        toolCalls: calls.length > 0 ? calls : null,
        label: 'adopted-' + profile,
        work,
        logs,
        cli,
        timeoutMs: options.timeoutMs,
        sourceHome,
        cwd: work,
      });
      if (outcome.error) throw new Error('the post-adoption ' + profile + ' consumer boot failed: ' + outcome.error);
      for (const call of outcome.result.toolCalls || []) {
        const failure = checkToolExpectation(call);
        if (failure) throw new Error('post-adoption: ' + failure);
      }
      postAdoption[profile] = { rows: outcome.result.rows || [], toolCalls: outcome.result.toolCalls || [] };
    }
    const evolutionAfter = treeDigest(path.join(sourceHome, 'storages', 'evolution'), { exclude: ['shared-plugins'] });
    const experienceAfter = await experienceRows(sourceHome);
    if (evolutionAfter !== evolutionBefore) throw new Error('revalidation changed evolution state outside shared-plugins');
    if (JSON.stringify(experienceBefore) !== JSON.stringify(experienceAfter)) throw new Error('revalidation changed the shared experience rows');
    evidence.preserved = {
      evolutionTreeDigestBefore: evolutionBefore,
      evolutionTreeDigestAfter: evolutionAfter,
      experienceBefore,
      experienceAfter,
      promotedSources: Object.fromEntries(plugins.map((plugin) => {
        const record = records.find((row) => row.id === plugin.id);
        return [plugin.id, sha256File(path.join(sourceHome, 'storages', 'evolution', 'promoted', record.pluginName, 'lib', 'index.js'))];
      })),
    };
    if (sha256File(evidenceFile) !== evidenceSha256) throw new Error('the evidence file changed after it was adopted');
    adoptionReportFile = writeAdoptionReport(evidenceFile, redact({
      schemaVersion: 1,
      kind: 'dsh-evolution-revalidation-report',
      note: 'adoption and post-adoption proofs for the evidence file this report names; the evidence file itself stays byte-identical to the digest recorded in the publication index',
      evidenceFile: path.basename(evidenceFile),
      evidenceSha256,
      host,
      adoption,
      postAdoption,
      preserved: evidence.preserved,
    }, sourceHome, work));
  }

  const summary = {
    ok: true,
    host,
    evidenceFile,
    evidenceSha256,
    adoptionReportFile,
    targets: plugins.map((plugin) => ({ id: plugin.id, profiles: Object.keys(plugin.profiles) })),
    adopted: Boolean(adoption),
    postAdoptionVerified: Boolean(postAdoption),
    work,
  };
  if (!options.keep && !options.work) fs.rmSync(work, { recursive: true, force: true });
  if (options.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    console.log('revalidated ' + plugins.length + ' record(s) on DSH ' + host.dsh);
    for (const plugin of plugins) console.log('  ' + plugin.id + ' -> ' + Object.keys(plugin.profiles).join(', '));
    console.log('evidence: ' + evidenceFile);
    if (adoptionReportFile) console.log('adoption report: ' + adoptionReportFile);
    console.log(adoption ? 'adopted: yes' : 'adopted: no (pass --apply to adopt)');
    if (postAdoption) console.log('post-adoption consumer boots: active with no eligibility rewrite');
  }
  return 0;
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write('dsh-evolution-revalidation: ' + String(error && error.message || error) + '\n');
      process.exitCode = 1;
    },
  );
}

#!/usr/bin/env node
/**
 * dsh-evolution shared plugin operator CLI.
 *
 * The Desktop promotion authority decides *whether* a verified stable plugin may
 * be shared; the consumers in ACP and Web decide independently whether they can
 * actually mount it. This command is the trusted, explicit operator surface for
 * the parts a running entry cannot do for itself:
 *
 *   list        read-only report of the publication index, the per-profile
 *               revocations and each consumer's last activation result.
 *   disable     revoke one plugin's activation eligibility for one profile.
 *   enable      restore it (the revocation file is the only state involved).
 *   reset       clear a sticky consumer failure so the next start retries once.
 *   revalidate  adopt real isolated-host verification evidence for the host the
 *               data root currently runs on (used after a DSH upgrade).
 *
 * Nothing here promotes, rolls back or deletes a plugin, journal, canary state
 * or experience row. Revoking a profile only removes that profile's activation
 * eligibility; the Desktop stable promotion stays intact.
 *
 * Usage:
 *   node scripts/shared-plugins.mjs list [--home <DSH_HOME>]
 *   node scripts/shared-plugins.mjs disable --plugin <id> --profile acp|web [--reason <text>]
 *   node scripts/shared-plugins.mjs enable  --plugin <id> --profile acp|web
 *   node scripts/shared-plugins.mjs reset   --plugin <id> --profile acp|web
 *   node scripts/shared-plugins.mjs revalidate --evidence <evidence.json>
 *   [--data-root <dir>] [--json]
 *
 * Exit codes: 0 success, 1 refused/invalid input, 2 unreadable state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveEvolutionPaths } from '../lib/diagnostics.js';
import {
  consumerNeedsRestart,
  readConsumerState,
  readDisableState,
  readPromotedPlugin,
  readSharedIndex,
  setDisabledForProfile,
  sharingPaths,
  SHARED_CONSUMER_PROFILES,
  sha256,
  writeConsumerState,
} from '../lib/promoted-sharing.js';

function parseArgs(argv) {
  const options = { json: false, help: false };
  const [command, ...rest] = argv;
  options.command = command;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--home') options.home = value();
    else if (arg === '--data-root') options.dataRoot = value();
    else if (arg === '--plugin') options.plugin = value();
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--reason') options.reason = value();
    else if (arg === '--evidence') options.evidence = value();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `dsh-evolution shared plugins

Commands:
  list                                  report published records, revocations, consumer state
  disable --plugin <id> --profile <p>   revoke activation eligibility for acp or web
  enable  --plugin <id> --profile <p>   restore activation eligibility
  reset   --plugin <id> --profile <p>   clear a sticky failed activation
  revalidate --evidence <file>          adopt isolated real-host verification evidence

Options: [--home <DSH_HOME>] [--data-root <dir>] [--reason <text>] [--json]
`;

function pathsFor(options) {
  const resolved = resolveEvolutionPaths({ dshHome: options.home, dataRoot: options.dataRoot });
  return { dataRoot: resolved.dataRoot, pluginRoot: resolved.pluginRoot };
}

function requireConsumerProfile(options) {
  if (!SHARED_CONSUMER_PROFILES.includes(options.profile)) throw new Error(`--profile must be one of: ${SHARED_CONSUMER_PROFILES.join(', ')}`);
}

function pluginIdOf(options) {
  if (!/^evolution-promoted-[a-f0-9]{12}$/.test(String(options.plugin ?? ''))) throw new Error('--plugin must be a published plugin id (evolution-promoted-<12 hex>)');
  return options.plugin;
}

async function commandList(options) {
  const paths = pathsFor(options);
  const index = await readSharedIndex(paths);
  const disable = await readDisableState(paths);
  const consumers = {};
  for (const profile of SHARED_CONSUMER_PROFILES) {
    const state = await readConsumerState(paths, profile);
    consumers[profile] = {
      status: state.status,
      updatedAt: state.state?.updatedAt ?? null,
      observedIndexUpdatedAt: state.state?.observedIndexUpdatedAt ?? null,
      needsRestart: Boolean(state.state) && consumerNeedsRestart(index.updatedAt, state.state),
      plugins: (state.state?.plugins || []).map((row) => ({ id: row.id, status: row.status, reason: row.reason ?? null, activatedAt: row.activatedAt ?? null })),
    };
  }
  const records = [];
  for (const record of index.records) {
    let source = 'verified';
    try {
      const plugin = await readPromotedPlugin(paths, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });
      if (plugin.sourceSha256 !== record.sourceSha256) source = 'source-digest-mismatch';
      else if (plugin.manifestSha256 !== record.manifestSha256) source = 'manifest-digest-mismatch';
    } catch {
      source = 'source-unusable';
    }
    records.push({
      id: record.id,
      experimentId: record.experimentId,
      approvedProfiles: record.approvedProfiles,
      publishedAt: record.publishedAt,
      stable: record.stable,
      host: record.host,
      source,
      revalidation: Array.isArray(record.revalidation) ? record.revalidation : [],
      disabledProfiles: (disable.entries || []).filter((entry) => entry.pluginId === record.id).map((entry) => entry.profile),
    });
  }
  return {
    ok: index.status === 'ok' || index.status === 'absent',
    indexPath: sharingPaths(paths).indexPath,
    indexStatus: index.status,
    indexUpdatedAt: index.updatedAt,
    invalidRecords: index.invalid,
    records,
    consumers,
  };
}

async function commandSetEnabled(options, disabled) {
  const paths = pathsFor(options);
  requireConsumerProfile(options);
  const pluginId = pluginIdOf(options);
  const index = await readSharedIndex(paths);
  if (index.status !== 'ok' && index.status !== 'absent') throw new Error(`the publication index is ${index.status}; refusing to change activation eligibility`);
  if (!index.records.some((record) => record.id === pluginId)) throw new Error(`${pluginId} is not a published record; nothing to change`);
  const result = await setDisabledForProfile(paths, { pluginId, profile: options.profile, disabled, reason: options.reason });
  return { ok: true, pluginId, profile: options.profile, disabled, entries: result.entries };
}

async function commandReset(options) {
  const paths = pathsFor(options);
  requireConsumerProfile(options);
  const pluginId = pluginIdOf(options);
  const state = await readConsumerState(paths, options.profile);
  if (state.status === 'absent') return { ok: true, pluginId, profile: options.profile, cleared: false, detail: 'no consumer state' };
  if (state.status !== 'ok') throw new Error(`consumer state is ${state.status}; refusing to rewrite it`);
  const plugins = state.state.plugins.map((row) => (row.id === pluginId ? { id: row.id, status: 'pending-restart', reason: 'operator-reset', sourceSha256: row.sourceSha256 ?? null } : row));
  const next = { ...state.state, updatedAt: new Date().toISOString(), plugins };
  await writeConsumerState(paths, options.profile, next);
  return { ok: true, pluginId, profile: options.profile, cleared: true };
}

/**
 * Adopt verification evidence produced by an isolated real host run.
 *
 * The evidence is the only input that may widen the verified host identity of a
 * published record after a DSH upgrade. It must name the exact plugin id and
 * source digest, and it must prove activation in every profile it claims; the
 * command then records a new revalidation generation. A record whose bytes
 * changed since publication is refused rather than re-attested.
 */
async function commandRevalidate(options) {
  if (!options.evidence) throw new Error('--evidence <file> is required');
  const paths = pathsFor(options);
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(path.resolve(options.evidence), 'utf8'));
  } catch (error) {
    throw new Error(`evidence file is unreadable: ${error?.message || error}`);
  }
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== 'dsh-evolution-cross-entry-evidence' || !Array.isArray(evidence.plugins)) {
    throw new Error('evidence file is not a cross-entry verification report (schemaVersion 1)');
  }
  const host = evidence.host;
  if (!host || typeof host.dsh !== 'string' || typeof host.cordis !== 'string' || typeof host.include !== 'string') {
    throw new Error('evidence file does not record the verified host identity');
  }
  const index = await readSharedIndex(paths);
  if (index.status !== 'ok') throw new Error(`the publication index is ${index.status}; nothing can be revalidated`);
  const evidenceSha256 = sha256(fs.readFileSync(path.resolve(options.evidence)));
  const adopted = [];
  for (const candidate of evidence.plugins) {
    const record = index.records.find((row) => row.id === candidate?.id);
    if (!record) throw new Error(`evidence names ${candidate?.id}, which is not a published record`);
    if (candidate.sourceSha256 !== record.sourceSha256) throw new Error(`evidence source digest for ${record.id} does not match the published bytes`);
    const profiles = SHARED_CONSUMER_PROFILES.filter((profile) => candidate.profiles?.[profile]?.active === true);
    if (profiles.length === 0) throw new Error(`evidence does not prove activation for ${record.id} in any consumer profile`);
    const revalidation = {
      at: new Date().toISOString(),
      dsh: host.dsh,
      cordis: host.cordis,
      include: host.include,
      node: typeof host.node === 'string' ? host.node : null,
      profiles,
      evidenceSha256,
    };
    const { publishSharedRecord } = await import('../lib/promoted-sharing.js');
    const result = await publishSharedRecord(paths, {
      ...record,
      host: { ...record.host, dsh: host.dsh, cordis: host.cordis, include: host.include, node: host.node ?? record.host.node, verifiedAt: revalidation.at },
      revalidation: [...(record.revalidation || []), revalidation],
    });
    if (result.status !== 'updated' && result.status !== 'unchanged') throw new Error(`revalidation of ${record.id} was refused: ${result.reason || result.status}`);
    adopted.push({ id: record.id, profiles, status: result.status });
  }
  return { ok: true, adopted, host, evidenceSha256 };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.command || options.command === '--help' || options.command === '-h') { process.stdout.write(HELP); return 0; }
  let result;
  if (options.command === 'list') result = await commandList(options);
  else if (options.command === 'disable') result = await commandSetEnabled(options, true);
  else if (options.command === 'enable') result = await commandSetEnabled(options, false);
  else if (options.command === 'reset') result = await commandReset(options);
  else if (options.command === 'revalidate') result = await commandRevalidate(options);
  else throw new Error(`unknown command: ${options.command}`);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok === false ? 2 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`dsh-evolution-shared: ${error?.message || error}\n`);
  process.exitCode = 1;
}

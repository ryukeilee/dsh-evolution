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
 *   approve     grant an already-stable, already-published record to one more
 *               consumer profile, reusing its existing benefit evidence instead
 *               of running a new experiment. Requires explicit owner approval.
 *   supersede   make one published record yield to another in one profile, so a
 *               verified iteration replaces rather than accumulates beside the
 *               record it improves. Both records keep their verified bytes and
 *               stable proof; the old one stays in place as a rollback target.
 *   revoke-supersede  undo a supersession in one profile and disable the
 *               replacement there, restoring the previous record on next start.
 *
 * Nothing here promotes, rolls back or deletes a plugin, journal, canary state
 * or experience row. Revoking a profile only removes that profile's activation
 * eligibility; the Desktop stable promotion stays intact. Approving a profile
 * and superseding a record are operator annotations on already-verified bytes;
 * neither re-hashes a host as proof nor changes the recorded stable identity.
 *
 * Usage:
 *   node scripts/shared-plugins.mjs list [--home <DSH_HOME>]
 *   node scripts/shared-plugins.mjs disable --plugin <id> --profile acp|web [--reason <text>]
 *   node scripts/shared-plugins.mjs enable  --plugin <id> --profile acp|web
 *   node scripts/shared-plugins.mjs reset   --plugin <id> --profile acp|web
 *   node scripts/shared-plugins.mjs revalidate --evidence <evidence.json>
 *   node scripts/shared-plugins.mjs approve  --plugin <id> --profile acp|web
 *                                          --approval <owner words>
 *   node scripts/shared-plugins.mjs supersede --old <id> --new <id>
 *                                          --profile acp|web --approval <owner words>
 *   node scripts/shared-plugins.mjs revoke-supersede --old <id>
 *                                          --profile acp|web --approval <owner words>
 *   [--data-root <dir>] [--json]
 *
 * Exit codes: 0 success, 1 refused/invalid input, 2 unreadable state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveEvolutionPaths } from '../lib/diagnostics.js';
import {
  annotateSharedRecord,
  consumerNeedsRestart,
  readConsumerState,
  readDisableState,
  readPromotedPlugin,
  readSharedIndex,
  revokeSharedSupersession,
  setDisabledForProfile,
  sharingPaths,
  SHARED_CONSUMER_PROFILES,
  sha256,
  validateSharedRecord,
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
    else if (arg === '--approval') options.approval = value();
    else if (arg === '--old') options.old = value();
    else if (arg === '--new') options.new = value();
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
  approve --plugin <id> --profile <p>   grant an already-stable record a new profile
           --approval <text>            (reuses its existing benefit evidence)
  supersede --old <id> --new <id>       replace one stable record with another
           --profile <p> --approval <text>
  revoke-supersede --old <id>           undo a supersession in one profile
           --profile <p> --approval <text>

Options: [--home <DSH_HOME>] [--data-root <dir>] [--reason <text>] [--json]
`;

function pathsFor(options) {
  const resolved = resolveEvolutionPaths({ dshHome: options.home, dataRoot: options.dataRoot });
  return { dataRoot: resolved.dataRoot, pluginRoot: resolved.pluginRoot };
}

function requireConsumerProfile(options) {
  if (!SHARED_CONSUMER_PROFILES.includes(options.profile)) throw new Error(`--profile must be one of: ${SHARED_CONSUMER_PROFILES.join(', ')}`);
}

function pluginIdOf(value, flag = '--plugin') {
  if (!/^evolution-promoted-[a-f0-9]{12}$/.test(String(value ?? ''))) throw new Error(`${flag} must be a published plugin id (evolution-promoted-<12 hex>)`);
  return value;
}

function requireApproval(options) {
  if (typeof options.approval !== 'string' || options.approval.trim() === '') {
    throw new Error('--approval <the owner\'s explicit words> is required');
  }
  return options.approval;
}

/**
 * A bounded annotation for an operator decision. Only the SHA256 of the owner's
 * words and structured fields are persisted: no approval text, redacted or
 * otherwise, may enter the shared index or a revocation reason.
 */
function approvalAnnotation({ kind, profile, sourceSha256, approval, evidenceSha256 }) {
  return {
    kind,
    profile,
    sourceSha256,
    approvalSha256: sha256(approval),
    at: new Date().toISOString(),
    ...(typeof evidenceSha256 === 'string' ? { evidenceSha256 } : {}),
  };
}

/** Read a published record and re-hash its bytes; verified bytes are immutable. */
async function verifiedRecord(paths, id, flag) {
  const pluginId = pluginIdOf(id, flag);
  const index = await readSharedIndex(paths);
  if (index.status !== 'ok') throw new Error(`the publication index is ${index.status}; nothing can be changed`);
  const record = index.records.find((row) => row.id === pluginId);
  if (!record) throw new Error(`${pluginId} is not a published record; nothing to change`);
  const verdict = validateSharedRecord(record, paths);
  if (!verdict.ok) throw new Error(`${pluginId} is not a valid published record (${verdict.reason})`);
  let plugin;
  try {
    plugin = await readPromotedPlugin(paths, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });
  } catch (error) {
    throw new Error(`${pluginId} source is unusable: ${error?.message || error}`);
  }
  if (plugin.sourceSha256 !== record.sourceSha256 || plugin.manifestSha256 !== record.manifestSha256) {
    throw new Error(`${pluginId} bytes changed since publication; refusing to annotate them`);
  }
  return { record, index };
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
    disableStatus: disable.status,
    indexUpdatedAt: index.updatedAt,
    invalidRecords: index.invalid,
    records,
    consumers,
  };
}

async function commandSetEnabled(options, disabled) {
  const paths = pathsFor(options);
  requireConsumerProfile(options);
  const pluginId = pluginIdOf(options.plugin);
  const index = await readSharedIndex(paths);
  if (index.status !== 'ok' && index.status !== 'absent') throw new Error(`the publication index is ${index.status}; refusing to change activation eligibility`);
  if (!index.records.some((record) => record.id === pluginId)) throw new Error(`${pluginId} is not a published record; nothing to change`);
  const result = await setDisabledForProfile(paths, { pluginId, profile: options.profile, disabled, reason: options.reason });
  return { ok: true, pluginId, profile: options.profile, disabled, entries: result.entries };
}

async function commandReset(options) {
  const paths = pathsFor(options);
  requireConsumerProfile(options);
  const pluginId = pluginIdOf(options.plugin);
  const { resetConsumerPluginState } = await import('../lib/promoted-sharing.js');
  const result = await resetConsumerPluginState(paths, options.profile, pluginId);
  if (!result.cleared) return { ok: true, pluginId, profile: options.profile, cleared: false, detail: 'no consumer state' };
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
    if (!index.records.some((row) => row.id === candidate?.id)) throw new Error(`evidence names ${candidate?.id}, which is not a published record`);
    const profiles = SHARED_CONSUMER_PROFILES.filter((profile) => candidate.profiles?.[profile]?.active === true);
    if (profiles.length === 0) throw new Error(`evidence does not prove activation for ${candidate.id} in any consumer profile`);
    // The read above is only a cheap existence check. The digest check and the
    // write happen against the current record inside one lock, so a concurrent
    // approval cannot be erased by this revalidation.
    const result = await annotateSharedRecord(paths, candidate.id, (record) => {
      if (candidate.sourceSha256 !== record.sourceSha256) {
        throw new Error(`evidence source digest for ${record.id} does not match the published bytes`);
      }
      const revalidation = {
        at: new Date().toISOString(),
        dsh: host.dsh,
        cordis: host.cordis,
        include: host.include,
        node: typeof host.node === 'string' ? host.node : null,
        profiles,
        evidenceSha256,
      };
      return {
        ...record,
        host: { ...record.host, dsh: host.dsh, cordis: host.cordis, include: host.include, node: host.node ?? record.host.node, verifiedAt: revalidation.at },
        revalidation: [...(Array.isArray(record.revalidation) ? record.revalidation : []), revalidation],
      };
    });
    if (result.status !== 'updated' && result.status !== 'unchanged') {
      throw new Error(`revalidation of ${candidate.id} was refused: ${result.reason || result.status}`);
    }
    adopted.push({ id: candidate.id, profiles, status: result.status });
  }
  return { ok: true, adopted, host, evidenceSha256 };
}

/**
 * Grant an already-stable record to one more consumer profile.
 *
 * The benefit evidence, verified bytes, stable proof and host identity stay
 * exactly as they were: adding an entry is not a new hypothesis and must not
 * start a new experiment. What the operator supplies here is a fresh, explicit
 * approval for the new scope, recorded as a bounded annotation on the record.
 */
async function commandApprove(options) {
  requireConsumerProfile(options);
  const approval = requireApproval(options);
  const paths = pathsFor(options);
  const pluginId = pluginIdOf(options.plugin);
  const result = await annotateSharedRecord(paths, pluginId, (record) => {
    const approvedProfiles = [...new Set([...record.approvedProfiles, options.profile])];
    if (approvedProfiles.length === record.approvedProfiles.length) return null;
    const receipt = approvalAnnotation({
      kind: 'profile-approval', profile: options.profile, sourceSha256: record.sourceSha256, approval,
    });
    return {
      ...record,
      approvedProfiles,
      approvalExtensions: [...(Array.isArray(record.approvalExtensions) ? record.approvalExtensions : []), receipt],
    };
  });
  if (!['updated', 'unchanged'].includes(result.status)) {
    throw new Error(`approval of ${pluginId} was refused: ${result.reason || result.status}`);
  }
  const approvedProfiles = Array.isArray(result.record?.approvedProfiles) ? result.record.approvedProfiles : null;
  return {
    ok: true, pluginId, profile: options.profile,
    status: result.status === 'unchanged' ? 'already-approved' : result.status,
    ...(approvedProfiles ? { approvedProfiles } : {}),
  };
}

/**
 * Make one published record yield to another in one profile.
 *
 * Both records must be published, valid, byte-for-byte intact and already
 * approved in the profile. The marker is written inside the same index lock and
 * binds the replacement's exact source digest, so a later byte change cannot
 * silently inherit the decision. The old record is never deleted: disabling the
 * replacement (or revoking the supersession) restores it on the next start.
 */
async function commandSupersede(options) {
  requireConsumerProfile(options);
  const approval = requireApproval(options);
  const paths = pathsFor(options);
  const oldId = pluginIdOf(options.old, '--old');
  const newId = pluginIdOf(options.new, '--new');
  if (oldId === newId) throw new Error('--old and --new must name different published records');
  const { record: identity } = await verifiedRecord(paths, newId, '--new');
  let writtenMarker = null;
  const result = await annotateSharedRecord(paths, oldId, async (record, { index }) => {
    if (!record.approvedProfiles.includes(options.profile) || !identity.approvedProfiles.includes(options.profile)) {
      throw new Error('both records must be approved in the profile first; use approve with explicit owner approval');
    }
    // The replacement's bytes are checked inside the lock too: a mutation
    // between the cheap pre-read and the write cannot become the new authority.
    let plugin;
    try {
      plugin = await readPromotedPlugin(paths, { pluginName: identity.pluginName, moduleUrl: identity.moduleUrl, entry: identity.entry });
    } catch {
      throw new Error(`${newId} source is unusable`);
    }
    if (plugin.sourceSha256 !== identity.sourceSha256 || plugin.manifestSha256 !== identity.manifestSha256) {
      throw new Error(`${newId} bytes changed since publication; refusing to annotate them`);
    }
    // Reject a cycle before it can be written: A→B followed by B→A would make
    // every record in the loop suppress the next and leave nothing mounted.
    const byId = new Map(index.records.map((row) => [row.id, row]));
    const seen = new Set();
    let walk = identity;
    while (walk && !seen.has(walk.id)) {
      seen.add(walk.id);
      if (walk.id === oldId) throw new Error(`${newId} already supersedes ${oldId} in ${options.profile}; a cycle is not allowed`);
      const marker = walk.supersededBy?.[options.profile];
      walk = marker ? byId.get(marker.recordId) : null;
    }
    const existing = record.supersededBy?.[options.profile];
    if (existing && (existing.recordId !== newId || existing.sourceSha256 !== identity.sourceSha256)) {
      throw new Error(`${oldId} is already superseded in ${options.profile} by ${existing.recordId}; chaining is not allowed`);
    }
    if (existing) return null;
    const marker = approvalAnnotation({
      kind: 'supersede-approval',
      profile: options.profile,
      sourceSha256: identity.sourceSha256,
      approval,
      evidenceSha256: index.digest,
    });
    marker.recordId = newId;
    writtenMarker = marker;
    return { ...record, supersededBy: { ...(record.supersededBy || {}), [options.profile]: marker } };
  });
  if (!['updated', 'unchanged'].includes(result.status)) {
    throw new Error(`supersession of ${oldId} was refused: ${result.reason || result.status}`);
  }
  return {
    ok: true, oldId, newId, profile: options.profile,
    status: result.status === 'unchanged' ? 'already-superseded' : result.status,
    ...(writtenMarker ? { supersededBy: writtenMarker } : {}),
  };
}

/**
 * Undo a supersession in one profile and disable the replacement there.
 *
 * Removing the marker alone would mount both overlapping plugins again, so the
 * replacement is revoked in the same profile first. The previous record and its
 * evidence are untouched; an operator can restore the replacement with `enable`.
 */
async function commandRevokeSupersede(options) {
  requireConsumerProfile(options);
  const approval = requireApproval(options);
  const paths = pathsFor(options);
  const oldId = pluginIdOf(options.old, '--old');
  const receipt = approvalAnnotation({ kind: 'revoke-supersede', profile: options.profile, sourceSha256: '0'.repeat(64), approval });
  const result = await revokeSharedSupersession(paths, {
    oldId,
    profile: options.profile,
    reason: `revoke-supersede:${receipt.approvalSha256.slice(0, 12)}`,
  });
  if (result.status === 'refused' || result.status === 'conflict') {
    throw new Error(`revoke-supersede of ${oldId} was refused: ${result.reason || result.status}`);
  }
  return {
    ok: true, oldId, profile: options.profile,
    status: result.status === 'unchanged' ? 'no-supersession' : result.status,
    ...(result.marker ? { newId: result.marker.recordId, approval: receipt } : {}),
  };
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
  else if (options.command === 'approve') result = await commandApprove(options);
  else if (options.command === 'supersede') result = await commandSupersede(options);
  else if (options.command === 'revoke-supersede') result = await commandRevokeSupersede(options);
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

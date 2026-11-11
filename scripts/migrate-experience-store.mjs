#!/usr/bin/env node
/**
 * One-time offline conversion of the unified shared experience store from
 * schema 1 (TEXT event identities) to schema 2 (32-byte BLOB identities in a
 * STRICT WITHOUT ROWID table).
 *
 * Normal plugin startup never converts storage. Stop Desktop, ACP and Web first:
 * this command takes an exclusive write transaction and rewrites the `events`
 * table. A private backup of the schema 1 database is written next to the store
 * by default, and every event id/digest plus every knowledge row is verified
 * before and after the swap. A failure leaves the schema 1 database untouched.
 *
 * Usage:
 *   node scripts/migrate-experience-store.mjs --dry-run [--root <dir> | --home <DSH_HOME>]
 *   node scripts/migrate-experience-store.mjs [--root <dir> | --home <DSH_HOME>]
 *     [--backup <path>] [--no-backup] [--no-vacuum] [--json]
 *
 * Exit codes: 0 converted or nothing to do, 1 refused/unsafe (busy store,
 * unknown schema, bad input, existing mismatched backup), 2 failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveEvolutionPaths } from '../lib/diagnostics.js';
import { migrateSharedExperience } from '../lib/shared-experience-migration.js';

function parseArgs(argv) {
  const options = { json: false, help: false, dryRun: false, backup: true, vacuum: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--root' || arg === '--experience-root') options.root = value();
    else if (arg === '--home') options.home = value();
    else if (arg === '--backup') options.backup = path.resolve(value());
    else if (arg === '--no-backup') options.backup = false;
    else if (arg === '--no-vacuum') options.vacuum = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const HELP = `dsh-evolution shared experience store

Converts the shared SQLite store from schema 1 (TEXT event ids) to schema 2
(32-byte BLOB ids, STRICT WITHOUT ROWID). Stop Desktop, ACP and Web first.
The default backup is written next to the database as experience.sqlite.v1-backup.

Usage:
  node scripts/migrate-experience-store.mjs [--root <dir> | --home <DSH_HOME>]
  node scripts/migrate-experience-store.mjs --dry-run [--json]

Options:
  --root <dir>       shared experience store directory (default: $DSH_HOME/storages/evolution-experience)
  --home <dir>       DSH_HOME used to resolve the default store directory
  --backup <path>    write the schema 1 backup to this path instead of the default
  --no-backup        do not keep a backup (refused for a pending conversion unless explicitly requested)
  --no-vacuum        convert without VACUUM; free pages and WAL are still checkpointed
  --dry-run          read-only report; never writes
  --json             machine-readable report
`;

function resolveRoot(options) {
  if (options.root) return path.resolve(options.root);
  const { dshHome } = resolveEvolutionPaths({ dshHome: options.home });
  return path.join(dshHome, 'storages', 'evolution-experience');
}

function megabytes(bytes) {
  return `${(Number(bytes) / (1024 * 1024)).toFixed(2)} MiB`;
}

function percent(before, after) {
  const start = Number(before);
  const end = Number(after);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return null;
  return `${(100 * (start - end) / start).toFixed(1)}%`;
}

function humanReport(report, options, root) {
  const lines = [`store: ${root}`];
  if (report.present === false || (report.missing === true)) {
    return lines.concat('no store database found; nothing to convert').join('\n') + '\n';
  }
  if (report.dryRun) {
    lines.push(`dry run, schema version: ${report.schemaVersion ?? 0}`);
    lines.push(`migration pending: ${report.pending === true}`);
    if (report.events !== undefined) lines.push(`rows: events ${report.events}, knowledge ${report.knowledge}`);
    if (report.bytes) {
      lines.push(`main database: ${megabytes(report.bytes.mainBytes)}, WAL: ${megabytes(report.bytes.walBytes)}`
        + `, events table+index: ${megabytes(report.bytes.eventsBytes ?? 0)}`);
    }
    return lines.join('\n') + '\n';
  }
  if (report.missing) return lines.concat('no store directory or database found; nothing to convert').join('\n') + '\n';
  if (report.empty) return lines.concat('the database is uninitialized; the next plugin start creates schema 2').join('\n') + '\n';
  if (report.alreadyMigrated) {
    lines.push(`already schema ${report.schemaVersion}; events ${report.events}, knowledge ${report.knowledge}`);
    if (report.reclaimed?.freedPages) lines.push(`reclaimed free pages: ${report.reclaimed.freedPages}`);
    for (const warning of report.warnings || []) lines.push(`warning: ${warning}`);
    return lines.join('\n') + '\n';
  }
  lines.push(`converted schema ${report.fromVersion} -> ${report.toVersion} in ${report.durationMs} ms`);
  lines.push(`events: ${report.events.before} rows, identity ${report.events.digest.slice(0, 16)}…`);
  lines.push(`knowledge: ${report.knowledge.before} rows, fingerprint ${report.knowledge.digest.slice(0, 16)}…`);
  const before = report.bytes?.before;
  const after = report.bytes?.after;
  if (before && after) {
    lines.push(`events table+index: ${megabytes(before.eventsBytes ?? 0)} -> ${megabytes(after.eventsBytes ?? 0)}`
      + ` (${percent(before.eventsBytes, after.eventsBytes) ?? 'n/a'} smaller)`);
    lines.push(`main database: ${megabytes(before.mainBytes)} -> ${megabytes(after.mainBytes)}`
      + ` (${percent(before.mainBytes, after.mainBytes) ?? 'n/a'} smaller)`);
    lines.push(`WAL after conversion: ${megabytes(after.walBytes)}; free pages after conversion: ${after.freelistCount}`);
  }
  lines.push(`vacuumed: ${report.reclaimed?.vacuumed === true}`);
  if (report.backup) {
    lines.push(`schema 1 backup: ${report.backup.path} (${megabytes(report.backup.bytes)}${report.backup.reused ? ', reused' : ''})`);
    lines.push(`restore: stop all entries and replace the database with this backup file`);
  } else {
    lines.push('schema 1 backup: disabled (--no-backup)');
  }
  for (const warning of report.warnings || []) lines.push(`warning: ${warning}`);
  return lines.join('\n') + '\n';
}

function exitCodeFor(error) {
  const message = String(error?.message || error);
  if (/^E_EXPERIENCE_(MIGRATION|SCHEMA|UNKNOWN_DATABASE|PRIVATE)/.test(message)) return 1;
  if (error?.code === 'ENOENT' || error?.code === 'EACCES') return 2;
  return 2;
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n\n${HELP}`); return 1; }
  if (options.help) { process.stdout.write(HELP); return 0; }
  const root = resolveRoot(options);
  try {
    const report = migrateSharedExperience(root, {
      dryRun: options.dryRun, backup: options.backup, vacuum: options.vacuum,
    });
    if (options.json) process.stdout.write(`${JSON.stringify({ root, ...report }, null, 2)}\n`);
    else process.stdout.write(humanReport(report, options, root));
    return 0;
  } catch (error) {
    const result = { root, error: String(error?.message || error), code: error?.code ?? null,
      migrationPhase: error?.migrationPhase ?? null };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`migration failed at ${result.migrationPhase || 'start'}: ${result.error}\n`);
    return exitCodeFor(error);
  }
}

process.exitCode = main(process.argv.slice(2));

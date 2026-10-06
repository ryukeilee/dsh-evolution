/**
 * COMPATIBILITY ADAPTER - legacy startup drift detection.
 *
 * The original Evolution installation detected drift between a live DSH tree
 * and a backup tree by importing `scripts/shared/drift-engine.js` from a
 * working tree recorded in a local state file. That external module is NOT
 * part of this package and is never loaded unless a caller explicitly enables
 * `startupDrift` and the configured state file points at such a tree.
 *
 * This adapter is disabled by default: the DSH plugin always passes
 * `startupDrift: false`, and `inspectLegacyStartupDrift` returns
 * `baseline-missing` / `backup-unavailable` instead of guessing a path.
 *
 * Removal condition: delete this file (and the one-line delegation in
 * `orchestrator.js`) once no supported DSH layout publishes a
 * `driftStatePath` + `repoRoot` drift engine. It exists only so a legacy
 * deployment can opt back in without re-adding the logic to the plugin core.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function pathExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export function legacyStartupDriftPaths(paths) {
  return {
    driftStatePath: paths?.driftStatePath || path.join(os.homedir(), ".local", "share", "dsh-local", "dsh-profiles-state.json"),
  };
}

export async function inspectLegacyStartupDrift(paths) {
  const { driftStatePath } = legacyStartupDriftPaths(paths);
  let state;
  try {
    state = JSON.parse(await fsp.readFile(driftStatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "baseline-missing" };
    throw error;
  }
  const enginePath = state.repoRoot ? path.join(state.repoRoot, "scripts", "shared", "drift-engine.js") : null;
  if (!enginePath || !await pathExists(enginePath)) return { status: "backup-unavailable", repoRoot: state.repoRoot || null };
  const imported = await import(`${pathToFileURL(enginePath).href}?startup=${Date.now()}`);
  const inspectDrift = imported.inspectDrift || imported.default?.inspectDrift;
  if (typeof inspectDrift !== "function") throw new Error("startup drift detector has no inspectDrift export");
  const report = await inspectDrift({
    repoRoot: state.repoRoot,
    liveRoot: state.liveRoot || path.join(os.homedir(), ".dsh"),
    stateFile: driftStatePath,
    installedVersionFile: path.join(os.homedir(), ".local", "share", "dsh-local", "current", "node_modules", "@deepseek-ai", "dsh", "package.json"),
  });
  const drifted = report.counts["backup-newer"] + report.counts["live-newer"] + report.counts.conflict;
  const status = drifted === 0 && report.versions.status === "same" && report.mounts.missing.length === 0 && report.mounts.conflicts.length === 0 ? "same" : "drift";
  return { status, versions: report.versions, counts: report.counts, mounts: { missing: report.mounts.missing.length, conflicts: report.mounts.conflicts.length } };
}

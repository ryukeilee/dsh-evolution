// The exact change plan `writeDurablePromotionUnlocked` writes for an
// experiment: the composition, the EVOLUTION.md pointer, this experiment's
// archive and the promoted plugin directory derived from the experiment id.
//
// Tests that need a journal the recovery path may act on use this fixture
// instead of hand-rolling a subset: `checkJournalBoundary` requires the complete
// plan, because a partial plan restores part of a transaction and then deletes
// the only evidence that the rest was applied.
import crypto from 'node:crypto';
import path from 'node:path';

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function derivedPluginName(experimentId) {
  return `dsh-evolution-promoted-${sha256(experimentId).slice(0, 12)}`;
}

export function derivedPluginPath(paths, experimentId) {
  return path.join(paths.pluginRoot, derivedPluginName(experimentId));
}

/**
 * @param {object} paths       resolved promotion paths
 * @param {string} experimentId
 * @param {Record<string, { existed?: boolean, before?: string, after?: string }>} [files]
 *        per-target override; `before`/`after` are the bytes the transaction
 *        captured and planned. Targets without an override are described as new
 *        files with synthetic content.
 */
export function promotionPlan(paths, experimentId, files = {}) {
  const archive = path.join(paths.archiveDir, `${experimentId}.md`);
  const record = (target, fallbackAfter) => {
    const spec = files[target] || {};
    const existed = spec.existed === true;
    const before = existed ? (spec.before ?? '') : null;
    const after = spec.after ?? fallbackAfter;
    return {
      type: 'file', target, existed,
      backup: `${sha256(target).slice(0, 16)}.bak`,
      beforeDigest: existed ? sha256(before) : null,
      expectedAfter: sha256(after),
    };
  };
  return [
    record(paths.compositionPath, '[]\n'),
    record(paths.evolutionPath, '# pointer\n'),
    record(archive, `# ${experimentId}\n`),
    { type: 'path', target: derivedPluginPath(paths, experimentId), existed: false },
  ];
}

import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fiberIsActive } from './cordis-compat.js';

// Use the official constructor/lifecycle; never synthesize loader entries on
// the profile tree or write profile node_modules. Subclassing captures the
// public Include instance without reaching into Cordis's private instances.
//
// Entry lookup goes through the loader's public `EntryTree.resolve(rowId)`
// ("Resolve an entry by id, including nested ids") instead of reading
// `EntryTree.store` directly, and fiber health goes through
// `fiberIsActive()` (documented lifecycle fields) instead of the
// `FiberState.ACTIVE` numeric literal, which is a `const enum` that the
// published runtime erases.
export async function mountPromotedInclude(ctx, paths) {
  let tree;
  class EvolutionPromotedInclude extends Include {
    constructor(context, config) {
      super(context, config);
      tree = this;
    }
  }
  const child = ctx.plugin(EvolutionPromotedInclude, {
    path: pathToFileURL(paths.compositionPath).href,
    initial: [],
  });
  await child.await();
  if (!tree || !fiberIsActive(child)) throw new Error('Evolution official Include did not activate');
  await tree.await();
  const parse = content => {
    const entries = yaml.load(content, { schema: entryListSchema });
    if (!Array.isArray(entries)) throw new Error('Evolution promoted composition must be an entry list');
    return entries;
  };
  /** Resolve one loaded row through the loader's public API. */
  const resolveRow = (rowId) => {
    if (typeof tree.resolve !== 'function') throw new Error('Evolution official Include has no public entry resolver');
    try {
      return tree.resolve(rowId);
    } catch {
      return undefined;
    }
  };
  const refresh = async () => {
    // Include.refresh deliberately swallows file errors; validate first and
    // compare after refresh so a last-good-tree fallback cannot masquerade as
    // a successful durable commit.
    const entries = parse(await fs.readFile(paths.compositionPath, 'utf8'));
    const liveRows = Array.isArray(tree.root?.data) ? tree.root.data : null;
    if (!liveRows) throw new Error('Evolution Include live entry list is unreadable; refusing to treat the refresh as committed');
    // The loader removes a dropped row with `EntryGroup.remove()`, which calls
    // `entry.fiber?.dispose()` and deletes the store slot without awaiting it,
    // so `EntryTree.await()` can no longer observe that entry's unload. Capture
    // the active fibers first and join them explicitly after the refresh.
    const detaching = [];
    for (const row of liveRows) {
      const entry = resolveRow(row?.id);
      if (!entry?.fiber || !fiberIsActive(entry.fiber)) continue;
      // A started fiber that cannot be awaited cannot be proven to have
      // finished its disposer, so the refresh is not reported as settled.
      if (typeof entry.fiber.await !== 'function') {
        throw new Error(`Evolution Include entry ${row?.id} exposes no awaitable fiber; refusing to report a settled refresh`);
      }
      detaching.push({ id: row?.id, fiber: entry.fiber });
    }
    await tree.refresh();
    await tree.await();
    // A row that is still mounted kept its fiber, so its disposal never began;
    // every other captured fiber was disposed by the refresh and must settle
    // before the caller may delete the journal or the plugin directory.
    for (const { id, fiber } of detaching) {
      if (resolveRow(id)?.fiber === fiber) continue;
      try { await fiber.await(); } catch (error) {
        throw new Error(`Evolution Include entry ${id} did not finish its disposal: ${error?.message || error}`);
      }
    }
    if (!Array.isArray(tree.root?.data)) {
      throw new Error('Evolution Include live entry list is unreadable; refusing to treat the refresh as committed');
    }
    if (!isDeepStrictEqual(tree.root.data, entries)) {
      throw new Error('Evolution Include retained a stale tree');
    }
  };
  return {
    parse,
    stringify: entries => yaml.dump(entries, { schema: entryListSchema }),
    refresh,
    // Recorded once from the live tree so the doctor can report exactly which
    // loader members this mount actually used, instead of probing a shape that
    // may not be reachable from the doctor's own module resolution.
    capabilities: {
      entryResolver: typeof tree.resolve === 'function',
      treeAwait: typeof tree.await === 'function',
      liveRootEntries: Array.isArray(tree.root?.data),
    },
    async verify(rowId, moduleUrl) {
      await refresh();
      const entry = resolveRow(rowId);
      if (!entry || entry.options.name !== moduleUrl || entry.disabled) {
        throw new Error(`Evolution promoted Include entry is not active: ${rowId}`);
      }
      if (typeof entry.fiber?.await === 'function') {
        // Settle any in-flight load/unload so the activity decision below is
        // made on a stable fiber; a failed startup is reported as inactive
        // with its own cause instead of a bare "not active".
        try { await entry.fiber.await(); } catch (error) {
          throw new Error(`Evolution promoted Include entry is not active: ${rowId} (${error?.message || error})`);
        }
      }
      if (!fiberIsActive(entry.fiber)) throw new Error(`Evolution promoted Include entry is not active: ${rowId}`);
      return { officialInclude: true, active: true };
    },
    async health(rowId, moduleUrl) {
      await this.verify(rowId, moduleUrl);
      const fiber = resolveRow(rowId)?.fiber;
      if (!fiber) throw new Error(`Evolution promoted Include entry disappeared during the health check: ${rowId}`);
      // Dependencies must actually be bound in the promoted entry's scope,
      // not merely declared or bound in the requesting agent's context.
      const dependenciesPresent = Object.keys(fiber.inject || {}).every(name => Boolean(fiber.ctx.get(name)));
      return { componentHealth: 'active', dependenciesPresent };
    },
  };
}

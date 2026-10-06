import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Use the official constructor/lifecycle; never synthesize loader entries on
// the profile tree or write profile node_modules. Subclassing captures the
// public Include instance without reaching into Cordis's private instances.
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
  if (!tree || child.state !== 2) throw new Error('Evolution official Include did not activate');
  await tree.await();
  const parse = content => {
    const entries = yaml.load(content, { schema: entryListSchema });
    if (!Array.isArray(entries)) throw new Error('Evolution promoted composition must be an entry list');
    return entries;
  };
  const refresh = async () => {
    // Include.refresh deliberately swallows file errors; validate first and
    // compare after refresh so a last-good-tree fallback cannot masquerade as
    // a successful durable commit.
    const entries = parse(await fs.readFile(paths.compositionPath, 'utf8'));
    await tree.refresh();
    await tree.await();
    if (!isDeepStrictEqual(tree.root.data, entries)) {
      throw new Error('Evolution Include retained a stale tree');
    }
  };
  return {
    parse,
    stringify: entries => yaml.dump(entries, { schema: entryListSchema }),
    refresh,
    async verify(rowId, moduleUrl) {
      await refresh();
      const entry = tree.store[rowId];
      if (!entry || entry.options.name !== moduleUrl || entry.disabled || entry.fiber?.state !== 2) {
        throw new Error(`Evolution promoted Include entry is not active: ${rowId}`);
      }
      return { officialInclude: true, active: true };
    },
    async health(rowId, moduleUrl) {
      await this.verify(rowId, moduleUrl);
      const fiber = tree.store[rowId].fiber;
      // Dependencies must actually be bound in the promoted entry's scope,
      // not merely declared or bound in the requesting agent's context.
      const dependenciesPresent = Object.keys(fiber.inject || {}).every(name => Boolean(fiber.ctx.get(name)));
      return { componentHealth: 'active', dependenciesPresent };
    },
  };
}

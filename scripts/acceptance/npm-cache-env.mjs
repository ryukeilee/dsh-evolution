import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * Give one npm child process cache and log directories owned by its fixture.
 * The fixture's existing cleanup removes them with the rest of its temporary tree.
 */
export function createPrivateNpmEnv(fixtureRoot, inherited = process.env) {
  const root = path.resolve(fixtureRoot);
  const state = path.join(root, '.npm-private', `${process.pid}-${randomUUID()}`);
  const npmCache = path.join(state, 'cache');
  const npmLogs = path.join(state, 'logs');

  if (isWithin(os.homedir(), npmCache) || isWithin(os.homedir(), npmLogs)) {
    throw new Error('private npm state must stay outside the user home directory');
  }

  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(npmLogs, { recursive: true });
  return {
    ...inherited,
    npm_config_cache: npmCache,
    npm_config_logs_dir: npmLogs,
  };
}

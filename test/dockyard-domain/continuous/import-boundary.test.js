import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
const directory = new URL('../../../lib/dockyard-domain/continuous/', import.meta.url);
test('continuous import and facade construction do not patch timers/EventEmitter, write files, or start scheduling', () => {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { EventEmitter } from 'node:events';
    const descriptors = Object.getOwnPropertyDescriptors(EventEmitter.prototype);
    for (const name of ['setTimeout','setInterval','setImmediate']) {
      globalThis[name] = () => { throw new Error('unexpected timer ' + name); };
    }
    const timers = { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate };
    for (const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync']) fs[name] = () => { throw new Error('unexpected write ' + name); };
    for (const name of ['writeFile','appendFile','mkdir','rename','unlink']) fsp[name] = () => { throw new Error('unexpected async write ' + name); };
    const domain = await import(${JSON.stringify(new URL('index.js', directory).href)});
    const facade = new domain.ContinuousEvolutionHarness();
    await facade.ready;
    assert.deepEqual(Object.getOwnPropertyDescriptors(EventEmitter.prototype), descriptors);
    for (const [name,value] of Object.entries(timers)) assert.equal(globalThis[name], value);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
});
test('all continuous imports remain inside the domain directory, no legacy runtime graph', async () => {
  const files = (await readdir(directory)).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)) {
      assert.match(match[1], /^\.\/[^/]+\.js$/, `${file}: ${match[1]}`);
    }
    assert.doesNotMatch(source, /getRuntimeTransaction|\.dockyard-dsh|module-runtime|node:os|effects\.mjs|components\.mjs/);
  }
});

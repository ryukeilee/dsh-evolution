// Filesystem call counter for the cold-absorption benchmarks.
//
// `archive-append-window.mjs` runs its workload in a child process and accepts
// an optional `BENCH_AUDIT_MODULE`:
//
//   BENCH_AUDIT_MODULE="$PWD/scripts/benchmarks/replay-io-audit.mjs" \
//     node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
//       --baseline-ref <commit> --records 20000 --rounds 3 --out <json>
//
// The module is imported before the measured tree, `install()` wraps the sync
// and promise fs entry points, and `start()`/`stop()` bracket only the
// absorption (the harness calls them around `openDomainStorage()`). Counts are
// calls and bytes passed through the JS API; they are not kernel syscalls and
// not physical disk traffic, and a call is counted even when the page cache
// serves it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const sizeOf = (value) => {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value === null || value === undefined) return 0;
  const size = Number(value.byteLength ?? value.length);
  return Number.isFinite(size) && size > 0 && typeof value !== 'number' ? size : 0;
};
const SYNC_CALLS = ['openSync', 'closeSync', 'statSync', 'lstatSync', 'fstatSync', 'renameSync', 'fsyncSync',
  'mkdirSync', 'rmSync', 'unlinkSync', 'linkSync', 'copyFileSync', 'existsSync', 'realpathSync'];
const SYNC_BYTES = {
  readFileSync: (value) => sizeOf(value),
  readSync: (value) => Number(value) || 0,
  writeSync: (value) => Number(value) || 0,
  writeFileSync: (value, args) => sizeOf(args[1]),
  appendFileSync: (value, args) => sizeOf(args[1]),
};
const ASYNC_CALLS = ['open', 'close', 'stat', 'lstat', 'rename', 'mkdir', 'rm', 'unlink', 'copyFile', 'access'];
const ASYNC_BYTES = {
  readFile: (_args, value) => sizeOf(value),
  writeFile: (args) => sizeOf(args[1]),
  appendFile: (args) => sizeOf(args[1]),
};

export function install() {
  let active = false;
  let counts = {};
  const bump = (name, bytes) => {
    if (!active) return;
    const entry = counts[name] ?? (counts[name] = { calls: 0, bytes: 0 });
    entry.calls += 1;
    entry.bytes += Number(bytes) || 0;
  };
  const wrapSync = (name, bytesOf) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function audited(...args) {
      const result = original.apply(this, args);
      bump(name, bytesOf ? bytesOf(result, args) : 0);
      return result;
    };
  };
  const wrapAsync = (name, bytesOf) => {
    const original = fsp[name];
    if (typeof original !== 'function') return;
    fsp[name] = function audited(...args) {
      bump(name, 0);
      const result = original.apply(this, args);
      if (bytesOf) result.then((value) => bump(`${name}.bytes`, bytesOf(args, value)), () => {});
      return result;
    };
  };
  for (const name of SYNC_CALLS) wrapSync(name, null);
  for (const [name, bytesOf] of Object.entries(SYNC_BYTES)) wrapSync(name, bytesOf);
  for (const name of ASYNC_CALLS) wrapAsync(name, null);
  for (const [name, bytesOf] of Object.entries(ASYNC_BYTES)) wrapAsync(name, bytesOf);
  syncBuiltinESMExports();
  return {
    async start() { counts = {}; active = true; },
    async stop() { active = false; return { ...counts }; },
  };
}

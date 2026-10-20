/**
 * An open port must prove it still owns the archive lock before it writes.
 *
 * The reclaim of a stale lock isolates the entry it inspected by renaming it to
 * a private name, which frees the lock path for as long as the verification
 * lasts. A third port can acquire the path in that window and keep it, and the
 * reclaim then fails correctly - but the port that acquired the path in the
 * window has already returned from `open()` and would keep committing. Two
 * ports that both believe they own the archive then overwrite each other: the
 * reviewer's interleaving left the first writer's committed observation on disk
 * nowhere, because the second writer's commit replaced the aggregate it had
 * never read.
 *
 * The fix is a fence at the durable write points of the port: before the commit
 * publishes its pending record, and before any staged file is installed into
 * the live tree (recovery included). The fence re-reads the lock entry -
 * `lstat` identity plus its bytes - and refuses the write when it is no longer
 * the entry `open()` created. The identity half is what the first test needs:
 * both ports belong to this process, so their lock bytes are the same pid and
 * only the inode distinguishes them.
 *
 * The fence is a check before the write, not a lease: the lock can still be
 * taken between the check and the syscall that follows it. That residual window
 * is why the reclaim itself keeps refusing to overwrite (see
 * `test/review-fix-storage-lock-reclaim.test.mjs`); it cannot be closed on a
 * filesystem without kernel leases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const LOCK_NAME = 'domain-archive.lock';
const OFFICIAL = path.join('official', 'evolution_domain.json');
const ARCHIVE = path.join('dockyard', 'state.json.observation-archive.jsonl');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-lock-fencing-'));
  const backends = [];
  const context = () => {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    backends.push(backend);
    const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    return ctx;
  };
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, context, config, backends, lock: path.join(root, LOCK_NAME) };
}

async function teardown(f) {
  for (const backend of f.backends) await backend.close();
  fs.rmSync(f.root, { recursive: true, force: true });
}

/** The durable domain document the official backend keeps for both ports. */
function rawDocument(f) {
  return JSON.parse(fs.readFileSync(path.join(f.root, OFFICIAL), 'utf8'));
}
const document = f => rawDocument(f).global;
const aggregateContains = (f, needle) => JSON.stringify(document(f).aggregate).includes(needle);

/** A pid that is provably not running any more. */
function deadPid() {
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(output);
}
/** A live holder of the lock path, so the refusal paths see a real owner. */
function liveHolder(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child.pid;
}

test('R6: a port whose lock was taken refuses the commit instead of overwriting the new owner', async () => {
  const f = await fixture();
  fs.writeFileSync(f.lock, String(deadPid()), { mode: 0o600 });

  // The reviewer's interleaving: the reclaim of the stale lock isolates the
  // entry it inspected, which frees the path. Port B acquires it inside that
  // window, the isolation then moves B's lock away, and port C takes the path
  // the move just freed. The reclaim detects the mismatch and fails, but B has
  // already returned from `open()`.
  const plainRename = fs.renameSync;
  let injected = false, isolated = null, lockInode = null;
  let portB, portC;
  fs.renameSync = function interleaved(from, to) {
    if (!injected && path.resolve(String(from)) === path.resolve(f.lock)) {
      injected = true;
      fs.unlinkSync(f.lock); // the stale entry is released…
      portB = openDomainStorage(f.context(), f.config); // …B acquires the free path…
      const moved = plainRename.call(fs, from, to); // …the reclaim isolates B's lock…
      isolated = String(to);
      portC = openDomainStorage(f.context(), f.config); // …and C takes the path the move freed.
      lockInode = fs.statSync(f.lock).ino;
      return moved;
    }
    return plainRename.call(fs, from, to);
  };
  let reclaimerError = null;
  try {
    await openDomainStorage(f.context(), f.config);
  } catch (caught) {
    reclaimerError = caught;
  } finally {
    fs.renameSync = plainRename;
  }

  assert.equal(injected, true, 'the isolation must actually have happened');
  assert.match(String(reclaimerError?.message), /E_DOMAIN_ARCHIVE_LOCK/,
    'the reclaim whose put-back target is occupied still reports failure');
  const [b, c] = await Promise.all([portB, portC]);
  assert.ok(b && c, 'the interleaving must leave two ports that both returned from open()');
  assert.equal(fs.statSync(f.lock).ino, lockInode, 'C holds the lock path');
  assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid),
    'both ports of this process carry the same pid bytes, so only the inode tells them apart');

  try {
    // B no longer owns the lock: its commit must be refused before anything is
    // published, and the refusal must name the lock.
    const commitError = await b.observe({ code: 'WRITER_B', target: 'tool:b' }).then(() => null, error => error);
    assert.match(String(commitError?.message), /E_DOMAIN_ARCHIVE_LOCK/,
      'a port whose lock was taken must refuse the commit');
    assert.equal(fs.existsSync(path.join(f.root, OFFICIAL)), false,
      'the refused commit must publish nothing at all: no pending record and no aggregate');
    assert.equal(b.query('observations').count, 0, 'the refused commit must not become visible on the port either');

    // C still owns the lock and commits normally.
    await c.observe({ code: 'WRITER_C', target: 'tool:c' });
    assert.equal(c.query('observations').count, 1);
    assert.equal(aggregateContains(f, 'WRITER_C'), true, "the lock owner's commit is durable");
    assert.equal(aggregateContains(f, 'WRITER_B'), false,
      'the lock owner keeps its committed data: the port that lost the lock installed nothing');

    // Releasing the port that lost the lock reports its failure and leaves the
    // new owner's lock exactly where it is.
    await assert.rejects(b.close(), /E_DOMAIN_ARCHIVE_LOCK/);
    assert.equal(fs.statSync(f.lock).ino, lockInode, 'a failed port must not remove the new owner lock');
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid));
    await c.close();
    assert.equal(fs.existsSync(f.lock), false, 'the lock owner releases its own lock');

    const reopened = await openDomainStorage(f.context(), f.config);
    assert.equal(reopened.query('observations').count, 1,
      'exactly one writer committed, so exactly one observation survives');
    assert.equal(aggregateContains(f, 'WRITER_C'), true);
    await reopened.close();
    assert.ok(isolated !== null);
    assert.equal(fs.readdirSync(f.root).filter(name => name.startsWith(LOCK_NAME) && name.endsWith('.orphan')).length, 1,
      'the isolated entry stays on disk as the auditable orphan of the failed reclaim');
  } finally {
    await teardown(f);
  }
});

test('R6: recovery also refuses to install a committed stage once the lock is gone', async (t) => {
  const f = await fixture();
  // Put the exact durable state a crash in the install step leaves behind on a
  // real document: a committed pending record that names a staged file, with
  // the live tree still untouched.
  const seeded = await openDomainStorage(f.context(), f.config);
  await seeded.observe({ code: 'WRITER_SEED', target: 'tool:seed' });
  await seeded.close();
  const file = 'state.json.observation-archive.jsonl';
  const bytes = Buffer.from(`${JSON.stringify({
    id: 'observation:review-six', status: 'observed', eventType: 'tool/error', recordedAt: '2026-09-01T00:00:00.000Z',
  })}\n`);
  const stage = `stage-${randomUUID()}`;
  const stageDir = path.join(f.root, 'domain-staging', stage);
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, file), bytes);
  const staged = rawDocument(f);
  staged.global.pending = {
    stage,
    aggregate: staged.global.aggregate,
    applied: staged.global.applied,
    files: [{ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  };
  fs.writeFileSync(path.join(f.root, OFFICIAL), JSON.stringify(staged));
  assert.equal(fs.existsSync(path.join(f.root, ARCHIVE)), false);

  // The recovery attempt loses the lock to another live owner between acquiring
  // it and installing the record. Recovery writes the live tree just like a
  // commit does, so it has to fence the same way and leave the record alone.
  const thief = liveHolder(t);
  const recovering = f.context();
  const open = recovering.storageDomain.open.bind(recovering.storageDomain);
  let stolen = null;
  recovering.storageDomain.open = async spec => {
    const opened = await open(spec);
    fs.unlinkSync(f.lock);
    fs.writeFileSync(f.lock, String(thief), { flag: 'wx', mode: 0o600 });
    stolen = fs.statSync(f.lock).ino;
    return opened;
  };
  await assert.rejects(openDomainStorage(recovering, f.config), /E_DOMAIN_ARCHIVE_LOCK/);
  assert.notEqual(stolen, null, 'the recovery attempt must have lost the lock');
  assert.equal(fs.existsSync(path.join(f.root, ARCHIVE)), false,
    'a port that does not hold the lock must not install the staged files');
  assert.notEqual(document(f).pending, null, 'the uninstalled record must stay durable for the real owner');
  assert.equal(fs.statSync(f.lock).ino, stolen, "the failed attempt must not remove the owner's lock");
  assert.equal(fs.readFileSync(f.lock, 'utf8'), String(thief));
  assert.equal(fs.existsSync(stageDir), true, 'the failed attempt must not delete a stage it did not install');

  // With the path free again the recovery is unchanged: the committed stage is
  // installed and its record is closed.
  fs.rmSync(f.lock);
  const recovered = await openDomainStorage(f.context(), f.config);
  assert.equal(document(f).pending, null, 'the owning port still closes the recovered record');
  assert.deepEqual(fs.readFileSync(path.join(f.root, ARCHIVE)), bytes,
    'the owning port still installs the committed stage byte for byte');
  assert.equal(fs.existsSync(stageDir), false, 'the installed stage is removed');
  await recovered.close();
  await teardown(f);
});

test('R6: the fence does not fire on the normal path', async (t) => {
  const f = await fixture();
  try {
    const port = await openDomainStorage(f.context(), f.config);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid),
      'the lock stays a bare pid file written by the process that holds it');
    for (let index = 0; index < 5; index++) await port.observe({ code: `WRITER_${index}`, target: `tool:x${index}` });
    assert.equal(port.query('observations').count, 5, 'repeated commits all succeed');
    assert.equal(document(f).pending, null);
    await port.close();
    assert.equal(fs.existsSync(f.lock), false, 'close still releases the lock this port wrote');

    // The acquisition paths are unchanged: a dead owner is reclaimed, a live
    // owner is refused, and a failed open leaves no lock behind.
    fs.writeFileSync(f.lock, String(deadPid()));
    const reclaimed = await openDomainStorage(f.context(), f.config);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), String(process.pid), 'a dead owner is still reclaimed');
    await reclaimed.close();

    fs.writeFileSync(f.lock, String(liveHolder(t)));
    await assert.rejects(openDomainStorage(f.context(), f.config), /E_DOMAIN_ARCHIVE_LOCK/);
    fs.rmSync(f.lock);

    const failing = f.context();
    failing.storageDomain.open = async () => { throw new Error('E_DOMAIN_MEDIUM_UNAVAILABLE'); };
    await assert.rejects(openDomainStorage(failing, f.config), /E_DOMAIN_MEDIUM_UNAVAILABLE/);
    assert.equal(fs.existsSync(f.lock), false, 'a failed open still releases the lock it wrote');
  } finally {
    await teardown(f);
  }
});

// Test-only file port; no legacy state-store, runtime snapshots or global binding.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
export class JsonStateStore {
  constructor({ home, filePath } = {}) { this.filePath = filePath ?? join(home, ".dockyard-dsh", "state.json"); this.queue = Promise.resolve(); }
  async load() { try { return JSON.parse(await readFile(this.filePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; return {}; } }
  async save(state) { await mkdir(dirname(this.filePath), { recursive: true }); await writeFile(this.filePath + ".tmp", JSON.stringify(state), { mode: 0o600 }); await rename(this.filePath + ".tmp", this.filePath); }
  update(fn) { const run = async () => { await this.save(await fn(await this.load())); }; const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
}

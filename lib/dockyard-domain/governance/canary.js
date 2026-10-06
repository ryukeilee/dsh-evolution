import { clone, timestamp } from "./helpers.js";
function boundedShare(value, fallback = 0.1) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback; }
function stableCanaryScore(key) { let hash = 2166136261; for (const char of String(key ?? Math.random())) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0) / 4294967296; }

/** Traffic allocation and evidence journal for one untrusted candidate. */
export class EvolutionCanaryBarrier {
  constructor({ candidateShare = 0.1, expansionSteps = [0.1, 0.25, 0.5, 1], minSamples = 3, clock = () => new Date(), state = null, barriers = {} } = {}) {
    const stored = state && typeof state === "object" ? state : {};
    this.candidateShare = boundedShare(stored.candidateShare ?? candidateShare);
    this.expansionSteps = [...new Set((stored.expansionSteps ?? expansionSteps).map((value) => boundedShare(value)).sort((a, b) => a - b))];
    if (!this.expansionSteps.includes(this.candidateShare)) this.expansionSteps.push(this.candidateShare);
    this.expansionSteps.sort((a, b) => a - b);
    this.minSamples = Math.max(1, Number(stored.minSamples ?? minSamples) || 3);
    this.barriers = { startupVerified: false, componentHealth: false, dependenciesPresent: false, ...(barriers ?? {}), ...(stored.barriers ?? {}) };
    this.clock = clock;
    this.stage = stored.stage ?? "canary";
    this.assignments = { incumbent: Number(stored.assignments?.incumbent) || 0, candidate: Number(stored.assignments?.candidate) || 0 };
    this.journal = Array.isArray(stored.journal) ? stored.journal.map(clone) : [];
  }
  route({ key = null, random = null } = {}) {
    const score = random !== null && random !== undefined && Number.isFinite(Number(random)) ? Number(random) : stableCanaryScore(key);
    const variant = score < this.candidateShare ? "candidate" : "incumbent";
    this.assignments[variant] += 1;
    this.record({ event: "assignment", key, score, variant, candidateShare: this.candidateShare });
    return variant;
  }
  record(entry = {}) { this.journal.push({ at: timestamp(this.clock), ...clone(entry) }); if (this.journal.length > 500) this.journal.splice(0, this.journal.length - 500); return clone(this.journal.at(-1)); }
  setBarriers(values = {}) { this.barriers = { ...this.barriers, ...values }; this.record({ event: "barrier_observe", barriers: this.barriers }); return this.snapshot(); }
  barriersPassed() { return this.barriers.startupVerified === true && this.barriers.componentHealth === true && this.barriers.dependenciesPresent === true; }
  expand() {
    const next = this.expansionSteps.find((share) => share > this.candidateShare);
    if (next === undefined) { this.stage = "validated"; return this.snapshot(); }
    this.candidateShare = next; this.stage = next >= 1 ? "validated" : "canary"; this.record({ event: "expand", candidateShare: next }); return this.snapshot();
  }
  markPromoted() { this.stage = "promoted"; this.record({ event: "promote", candidateShare: this.candidateShare }); return this.snapshot(); }
  markRolledBack(reason = "regression") { this.stage = "rolled_back"; this.record({ event: "rollback", reason, candidateShare: this.candidateShare }); return this.snapshot(); }
  snapshot() { return { candidateShare: this.candidateShare, baselineShare: 1 - this.candidateShare, expansionSteps: [...this.expansionSteps], minSamples: this.minSamples, stage: this.stage, barriers: { ...this.barriers }, assignments: { ...this.assignments }, journal: clone(this.journal) }; }
}


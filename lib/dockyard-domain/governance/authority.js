import { MutationAuthorityError } from "./mutation-authority.js";
import { isCordisTrustRootTarget, isHighTrustDshTarget, containsIrreversibleRisk } from "./trust-root.js";
import { clone, safeRecord, timestamp } from "./helpers.js";

export const EVOLUTION_AUTHORITY = Object.freeze({ OBSERVATION: 0, AUTONOMOUS_CAPABILITY: 1, CORE_PROPOSAL: 2, OWNER_APPROVED_CORE: 3 });
const OBSERVATIONS = new Set(["observation", "observe", "analyze", "diagnose", "detect-gap", "inspect", "report", "evaluate-report"]);
const CAPABILITY_ACTIONS = new Set([
  "capability.register", "capability.transition", "capability.recordUsage", "capability.recordVersion",
  "capability.create", "capability.load", "capability.promote", "capability.rollback", "capability.replace",
  "capability.promote-replacement", "capability.rollback-replacement", "capability.rollback-post-promotion",
  "capability.retire-suspect", "capability.retire-deprecate", "capability.retire-archive", "capability.retire-remove", "capability.restore",
]);
const FORBIDDEN = /(?:^|[.:/\\_-])(?:account|oauth|vault|provider|credentials?|secrets?|publish|execute|web)(?:$|[.:/\\_-])/i;
export class EvolutionAuthorityError extends Error {
  constructor(message, details = {}) { super(message); this.name = "EvolutionAuthorityError"; this.code = "evolution_authority_denied"; this.details = details; }
}
export function classifyAction({ kind = "", target = null } = {}) {
  if (OBSERVATIONS.has(kind)) return { category: "observation", level: 0 };
  if (kind.startsWith("core.")) return { category: kind === "core.propose" ? "core-proposal" : "core-mutation", level: kind === "core.propose" ? 2 : 3 };
  if (isCordisTrustRootTarget(target)) return { category: "core-mutation", level: 3 };
  return { category: "capability-evolution", level: 1 };
}
/** Pure decision only. Owner confirmation never unlocks excluded scopes or host writes. */
export function decideEvolutionAction(request = {}) {
  const kind = String(request.kind ?? "");
  const target = request.target ?? request.componentId ?? request.metadata?.target ?? null;
  const { category, level } = classifyAction({ kind, target });
  const reasons = [];
  if (request.authorityLevel !== undefined || request.context?.authorityLevel !== undefined || request.verified === true) reasons.push("forged_authority_context_ignored");
  let allowed = true;
  const requirements = [];
  if (!OBSERVATIONS.has(kind)) {
    if (!CAPABILITY_ACTIONS.has(kind) || typeof target !== "string" || !/^capability:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(target)) {
      allowed = false; reasons.push("capability_scope_required");
    }
    if (isCordisTrustRootTarget(target) || isCordisTrustRootTarget(typeof target === "string" ? target.replace(/^capability:/, "") : target)) { allowed = false; reasons.push("cordis_trust_root_immutable"); }
    if (FORBIDDEN.test(`${kind}:${target ?? ""}`) || kind.startsWith("core.")) { allowed = false; reasons.push("excluded_mutation_scope"); }
    requirements.push("lifecycle-tracked", "experiment-before-promotion", "rollback-required");
    if (isHighTrustDshTarget(target)) requirements.push("isolated-candidate", "regression-proof", "recovery-proof", "explicit-user-confirmation");
    if (containsIrreversibleRisk(`${kind} ${target} ${JSON.stringify(safeRecord(request.metadata ?? {}))}`) && request.confirmation !== true) { allowed = false; reasons.push("explicit_user_confirmation_required_for_irreversible_risk"); }
  }
  return { action: kind, target, category, requiredLevel: level, level, allowed, decision: allowed ? "allowed" : "rejected", reasons, requirements };
}
/** Host retains this gate and authority; do not expose run/execute capabilities to candidates. */
export class EvolutionAuthorityGate {
  #decisions = [];
  constructor({ mutationAuthority, authorize, clock = () => new Date() } = {}) {
    if (!mutationAuthority) throw new MutationAuthorityError("governance.authority.required");
    if (typeof authorize !== "function") throw new EvolutionAuthorityError("Host authorization port required");
    this.mutationAuthority = mutationAuthority;
    this.authorize = authorize;
    this.clock = clock;
  }
  decide(request) { return decideEvolutionAction(request); }
  async execute(request, perform) {
    const decision = this.decide(request);
    if (!decision.allowed) throw new EvolutionAuthorityError("Evolution action rejected", { decision });
    const hostDecision = await this.authorize(clone(decision), clone(request));
    if (hostDecision?.allowed !== true) throw new EvolutionAuthorityError("Host authorization denied", { decision });
    this.#decisions.push({ ...decision, at: timestamp(this.clock) });
    if (this.#decisions.length > 200) this.#decisions.shift();
    if (typeof perform !== "function") return decision;
    return this.mutationAuthority.run(request.kind, () => perform(decision));
  }
  decisions(limit = 50) { return clone(this.#decisions.slice(-limit)); }
}

/**
 * `manifest-contract.js` has no production caller for its version predicates:
 * nothing outside the module imports `satisfiesVersionRequirement`,
 * `checkComponentCompatibility` or `createComponentContract`, and
 * `normalizeComponentContract` (reached through `manifest.js`) never evaluates a
 * requirement. It is still the module's only version decision, so it answers
 * with full `major.minor.patch` semantics instead of the first number, and a
 * dependency is matched against a declared provide by exact name instead of
 * `String.prototype.includes`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkComponentCompatibility,
  normalizeComponentContract,
  satisfiesVersionRequirement,
} from "../lib/dockyard-domain/manifest-contract.js";

test("a comparison reads every version component", () => {
  assert.equal(satisfiesVersionRequirement("1.0.0", ">=1.9.0"), false);
  assert.equal(satisfiesVersionRequirement("1.9.0", ">=1.9.0"), true);
  assert.equal(satisfiesVersionRequirement("1.10.0", ">1.9.0"), true);
  assert.equal(satisfiesVersionRequirement("1.9.1", "<1.10.0"), true);
  assert.equal(satisfiesVersionRequirement("1.0.1", "=1.0.0"), false);
  assert.equal(satisfiesVersionRequirement("1.0.0", "=1.0.0"), true);
  assert.equal(satisfiesVersionRequirement("v1.2.3", "1.2.3"), true);
  // An omitted component is 0, exactly as this module always read it, so an
  // exact comparison against "1.2" is a comparison against 1.2.0.
  assert.equal(satisfiesVersionRequirement("1.2.3", "1.2"), false);
  assert.equal(satisfiesVersionRequirement("1.2.0", "1.2"), true);
});

test("caret and tilde use their real upper bounds", () => {
  assert.equal(satisfiesVersionRequirement("0.9.9", "^0.2.3"), false);
  assert.equal(satisfiesVersionRequirement("0.2.2", "^0.2.3"), false);
  assert.equal(satisfiesVersionRequirement("0.2.3", "^0.2.3"), true);
  assert.equal(satisfiesVersionRequirement("0.2.9", "^0.2.3"), true);
  assert.equal(satisfiesVersionRequirement("0.3.0", "^0.2.3"), false);
  assert.equal(satisfiesVersionRequirement("1.5.0", "^1.2.3"), true);
  assert.equal(satisfiesVersionRequirement("2.0.0", "^1.2.3"), false);
  assert.equal(satisfiesVersionRequirement("0.0.3", "^0.0.3"), true);
  assert.equal(satisfiesVersionRequirement("0.0.4", "^0.0.3"), false);
  assert.equal(satisfiesVersionRequirement("1.9.1", "~1.9.0"), true);
  assert.equal(satisfiesVersionRequirement("1.10.0", "~1.9.0"), false);
  assert.equal(satisfiesVersionRequirement("1.0.5", "~1.0"), true);
  assert.equal(satisfiesVersionRequirement("1.1.0", "~1.0"), false);
});

test("ranges, alternation and the object form keep working", () => {
  assert.equal(satisfiesVersionRequirement("1.5.0", ">=1.2.3 <2.0.0"), true);
  assert.equal(satisfiesVersionRequirement("2.0.0", ">=1.2.3 <2.0.0"), false);
  assert.equal(satisfiesVersionRequirement("3.0.0", "^1.2.3 || ^3.0.0"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3", "*"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3", ""), true);
  assert.equal(satisfiesVersionRequirement("1.5.0", { min: "1.2.0", max: "2.0.0" }), true);
  assert.equal(satisfiesVersionRequirement("2.5.0", { min: "1.2.0", max: "2.0.0" }), false);
  assert.equal(satisfiesVersionRequirement("1.2.4", { exact: "1.2.3" }), false);
  // Build metadata never decides a comparison.
  assert.equal(satisfiesVersionRequirement("1.2.3+build.5", "=1.2.3"), true);
});

test("a prerelease is ordered and gated", () => {
  assert.equal(satisfiesVersionRequirement("1.2.3-beta.1", ">=1.2.3"), false);
  assert.equal(satisfiesVersionRequirement("1.2.4", ">=1.2.3-beta.1"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3-beta.2", ">=1.2.3-beta.1"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3-alpha", ">=1.2.3-beta.1"), false);
  assert.equal(satisfiesVersionRequirement("1.2.3", ">=1.2.3-beta.1"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3-beta.1", "^1.2.3-beta.1"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3-alpha.1", "^1.2.3-beta.1"), false);
  assert.equal(satisfiesVersionRequirement("1.2.3-beta.11", ">1.2.3-beta.2"), true);
  assert.equal(satisfiesVersionRequirement("1.2.3-beta", ">1.2.3-beta.2"), false);
});

test("a provide is matched by name, never by substring", () => {
  const consumer = { name: "consumer", version: "1.0.0", requires: [{ id: "tool", versionRange: "*" }] };
  const compatible = (availableComponents) => checkComponentCompatibility(consumer, { availableComponents });

  const substring = compatible([{ id: "provider", version: "1.0.0", provides: "toolbox" }]);
  assert.equal(substring.compatible, false);
  assert.deepEqual(substring.reasons, ["missing dependency: tool"]);
  assert.equal(compatible([{ id: "provider", version: "1.0.0", provides: "capabilities-not-tool" }]).compatible, false);

  assert.equal(compatible([{ id: "provider", version: "1.0.0", provides: "tool" }]).compatible, true);
  assert.equal(compatible([{ id: "provider", version: "1.0.0", provides: ["other", "tool"] }]).compatible, true);
  assert.equal(compatible([{ id: "provider", version: "1.0.0", provides: "  tool  " }]).compatible, true);
  assert.equal(compatible([{ id: "provider", version: "1.0.0", provides: "toolbox", capabilities: ["tool"] }]).compatible, false);
  assert.equal(compatible([{ id: "provider", version: "1.0.0", capabilities: "toolbox" }]).compatible, false);
  assert.equal(compatible([{ id: "tool", version: "1.0.0" }]).compatible, true);

  const versioned = { name: "consumer", version: "1.0.0", requires: [{ id: "tool", versionRange: "^2.0.0" }] };
  assert.equal(checkComponentCompatibility(versioned, { availableComponents: [{ id: "provider", version: "2.1.0", provides: "tool" }] }).compatible, true);
  assert.equal(checkComponentCompatibility(versioned, { availableComponents: [{ id: "provider", version: "1.9.0", provides: "tool" }] }).compatible, false);
});

test("the contract normalization this module is reached through is unchanged", () => {
  const contract = normalizeComponentContract({ name: "component", version: "1.2.3", provides: "tool", requires: ["other"] });
  assert.equal(contract.version, "1.2.3");
  assert.deepEqual(contract.provides, ["tool"]);
  assert.deepEqual(contract.dependencies.map((requirement) => requirement.id), ["other"]);
});

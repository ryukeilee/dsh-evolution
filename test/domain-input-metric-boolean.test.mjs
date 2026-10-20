/**
 * The canonical metric projection reads a boolean flag with `Boolean()`, which
 * makes every non-empty string true - `success: "false"` and
 * `regressionPassed: "false"` were projected as success. The projection now
 * parses the flag instead: real booleans, 0/1, and the true/false spellings the
 * projection itself emits for a status. An unparsable value stays unknown and
 * falls back to the status, exactly as a missing flag does.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { projectEvolutionMetric } from "../lib/dockyard-domain/metric-projection.js";

const NOW = "2026-10-12T00:00:00.000Z";
const CLOCK = { clock: () => new Date(NOW) };

function task(sample) {
  return projectEvolutionMetric("task", sample, CLOCK);
}

test("a false flag is projected as false, not as its own text", () => {
  for (const value of [false, 0, "0", "false", "FALSE", " false ", "no", "off"]) {
    assert.equal(task({ success: value }).success, false, `success: ${JSON.stringify(value)}`);
    assert.equal(task({ ok: value }).success, false, `ok: ${JSON.stringify(value)}`);
    assert.equal(task({ completed: value }).success, false, `completed: ${JSON.stringify(value)}`);
    assert.equal(task({ passed: value }).success, false, `passed: ${JSON.stringify(value)}`);
  }
});

test("a true flag is still projected as true", () => {
  for (const value of [true, 1, "1", "true", "TRUE", " true ", "yes", "on"]) {
    assert.equal(task({ success: value }).success, true, `success: ${JSON.stringify(value)}`);
    assert.equal(task({ passed: value }).success, true, `passed: ${JSON.stringify(value)}`);
  }
});

test("a component regression flag is parsed, including its stability", () => {
  const failed = projectEvolutionMetric("component", { componentId: "c", regressionPassed: "false" }, CLOCK);
  assert.equal(failed.regressionPassed, false);
  assert.equal(failed.stability, 0);
  const passed = projectEvolutionMetric("component", { componentId: "c", regressionPassed: "true" }, CLOCK);
  assert.equal(passed.regressionPassed, true);
  assert.equal(passed.stability, 1);
  assert.equal(projectEvolutionMetric("component", { componentId: "c", regressionPassed: 0 }, CLOCK).regressionPassed, false);
  assert.equal(projectEvolutionMetric("component", { componentId: "c", regressionPassed: false }, CLOCK).regressionPassed, false);
  // No flag at all stays unknown, as before.
  const unknown = projectEvolutionMetric("component", { componentId: "c" }, CLOCK);
  assert.equal(unknown.regressionPassed, null);
  assert.equal(unknown.stability, null);
});

test("count indicators keep their numeric reading", () => {
  const agent = projectEvolutionMetric("agent", { agentId: "a", userCorrection: "3", toolSelectionFailure: "false" }, CLOCK);
  assert.equal(agent.userCorrection, 3);
  assert.equal(agent.toolSelectionFailure, 0);
  const flag = projectEvolutionMetric("agent", { agentId: "a", userCorrection: true }, CLOCK);
  assert.equal(flag.userCorrection, 1);
  assert.equal(projectEvolutionMetric("agent", { agentId: "a" }, CLOCK).userCorrection, null);
});

test("an unparsable flag falls back to the status instead of claiming success", () => {
  assert.equal(task({ success: "maybe", status: "failed" }).success, false);
  assert.equal(task({ success: {}, status: "failed" }).success, false);
  assert.equal(task({ success: "maybe" }).success, null);
  // A real boolean is never overridden by the status.
  assert.equal(task({ success: true, status: "failed" }).success, true);
  assert.equal(task({ success: false, status: "success" }).success, false);
});

test("the status fallback is unchanged", () => {
  assert.equal(task({ status: "failed" }).success, false);
  assert.equal(task({ status: "success" }).success, true);
  assert.equal(task({ status: "cancelled" }).success, false);
  assert.equal(task({}).success, null);
});

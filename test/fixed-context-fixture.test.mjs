import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from '../scripts/benchmarks/fixed-context/fixture.mjs';

test('the context-cost fixture reaches owner confirmation through the real Include adapter and restores its Trial', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-context-fixture-'));
  let f;
  try {
    f=await fixture(root);
    assert.equal(f.tools.length,12);
    const proposed=await f.call('evolution_propose',{why:'fixture regression',target:'plugin:context-fixture',impactScope:['test'],successMetrics:['recovery']});
    const experimentId=proposed.experimentId;
    await f.call('evolution_trial',{experimentId,composition:{name:'context-fixture',purpose:'exercise official teardown',code:{host:'return { name: "context-fixture", apply(ctx) { ctx.on("fixture/context", () => {}); } };'}}});
    await f.call('evolution_measure',{experimentId,observation:{solvesProblem:true,sideEffects:[],orphanResources:[],beforeMetrics:{latencyMs:100},afterMetrics:{latencyMs:80},sampleCount:30,observationWindow:'fixture-window-1',benefitEvidence:'supplied synthetic samples',repeatable:true,regressionPassed:true,reversible:true,cleanupEvidence:'official teardown is checked by revert'}});
    const before=await fs.readFile(path.join(root,'promoted.cordis.yml'),'utf8');
    const decision=await f.call('evolution_promote',{experimentId,confirmation:false});
    assert.equal(decision.phase,'awaiting-owner-confirmation');
    assert.equal(decision.gates.eligible,true);
    assert.equal(await fs.readFile(path.join(root,'promoted.cordis.yml'),'utf8'),before);
    assert.equal((await f.call('evolution_revert',{experimentId})).runtimeRecovered,true);
    assert.equal(f.core.targetOwners.size,0);
  } finally {
    await f?.close();
    await fs.rm(root,{recursive:true,force:true});
  }
});

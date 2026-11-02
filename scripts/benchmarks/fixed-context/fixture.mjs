// Isolated official Cordis/Tools/Host Runner fixture; no production profile.
import fs from 'node:fs';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { mountPromotedInclude } from '../../../lib/promotion-include.js';
import Tools from '@deepseek-ai/dsh-tools';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Runner from '@deepseek-ai/dsh-cordis-host-runner';
import { collectDiagnostics, resolveEvolutionPaths } from '../../../lib/diagnostics.js';
import { apply } from '../../../lib/registration.js';
import { openFixture, configFor } from '../../../test/retention-boundary-worker.mjs';
export async function fixture(root) {
 fs.mkdirSync(root,{recursive:true});
 const ctx=new Context();
 const mounted=[];
 for(const [plugin,config] of [[Loader,{}],[Prompt,{}],[Tools,{}],[Runner,{vmTimeoutMs:5000,clientInspectTimeoutMs:10000}]]){const f=ctx.plugin(plugin,config);mounted.push(f);await f.await();}
 const owner={id:'free-context-owner',ctx:ctx.extend({})};
 const warm=ctx.dynamicCordisRunner.define({sessionId:owner.id,plugin:{kind:'new',idPrefix:'evo'},name:'warmup',purpose:'Initialize official shared dynamic infrastructure before baseline capture',code:{host:'return { name: "warmup", apply() {} };'}});
 await ctx.dynamicCordisRunner.run(owner,warm.pluginId,warm.packageId,'run',new AbortController().signal);
 await ctx.dynamicCordisRunner.stop(owner,warm.pluginId);
 await ctx.dynamicCordisRunner.undefine(owner,warm.pluginId);
 const compositionPath=path.join(root,'promoted.cordis.yml');
 fs.writeFileSync(compositionPath,'[]\n');
 let promotionRuntime;
 const include=ctx.plugin({name:'fixture-official-include',async apply(scope){promotionRuntime=await mountPromotedInclude(scope,{compositionPath});}});
 mounted.push(include);await include.await();
 const domain=await openFixture(root);
 for(let i=0;i<3;i++)await domain.port.observe({type:"tool/error",code:`FIXTURE_LATENCY_${i}`,target:"plugin:latency-probe",message:"synthetic latency regression"});
 let text;
 const sc=ctx.systemPrompt.section.bind(ctx.systemPrompt);
 // Capture the actual registration text while still using the official section.
 const systemPrompt={section(s){text=s.text;return sc(s)}};
 const core=apply({tools:ctx.tools,dynamicCordisRunner:ctx.dynamicCordisRunner,systemPrompt,registry:ctx.registry,reflect:ctx.reflect,events:ctx.events,get:ctx.get.bind(ctx)}, {...configFor(root), startupDrift:false,compositionPath,promotionRuntime,domainStorage:domain.port,diagnose:async options=>collectDiagnostics({...options,paths:resolveEvolutionPaths({dshHome:path.join(root,'home')}),dshHome:path.join(root,'home'),home:true,profileCandidates:[],probe:{skipComposition:true}})});
 const agent={id:'free-context-owner',ctx:ctx.extend({})};
 return {ctx,core,text,tools:ctx.tools.schemas(),async call(name,args={}){const d=ctx.tools.get(name,agent);return await d.execute(args,{agent,signal:new AbortController().signal});},async close(){await domain.close(); for(const fiber of mounted.reverse())await fiber.dispose();}};
}
if(process.argv[2]==='--capture') {
 const f=await fixture(process.argv[3]);
 try {console.log(JSON.stringify({system:f.text,tools:f.tools}));} finally {await f.close();}
}

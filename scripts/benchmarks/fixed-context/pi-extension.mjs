import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
export default async function(pi) {
 const root=process.env.EVOLUTION_FREE_RUN;
 const f=await fixture(path.join(root,'domain'));
 const trace=(row)=>fs.appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify(row)+'\n');
 fs.writeFileSync(path.join(root,'registered.json'),JSON.stringify({system:f.text,tools:f.tools},null,2));
 for(const tool of f.tools) pi.registerTool({name:tool.name,label:tool.name,description:tool.description,parameters:tool.parameters,async execute(_id,args){
  trace({kind:'call',name:tool.name,args});
  try {const value=await f.call(tool.name,args);trace({kind:'result',name:tool.name,value});return {content:[{type:'text',text:JSON.stringify(value)}],details:value};}
  catch(error){trace({kind:'error',name:tool.name,code:error.code,message:error.message});throw error;}
 }});
 pi.on('before_provider_request',event=>{trace({kind:'request',payload:event.payload});});
 pi.on('session_shutdown',async()=>{trace({kind:'final',experiments:[...f.core.experiments.values()].map(e=>({state:e.state,targetsAcquired:e.targetsAcquired})),owners:f.core.targetOwners.size});await f.close();});
}

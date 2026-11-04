import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {WebSocket} from 'ws';
import {createStudioBridge} from './studio-bridge.mjs';

async function fixture(options={}){
 const runtime=path.resolve('.runtime');await fs.mkdir(runtime,{recursive:true});
 const root=await fs.mkdtemp(path.join(runtime,'studio-scope-test-')),initial=path.join(root,'initial');
 await fs.mkdir(initial);await fs.writeFile(path.join(initial,'main.tex'),'initial workspace');
 const token='a1'.repeat(32),bridge=createStudioBridge({initialProject:initial,sessionToken:token,modelStatePath:path.join(root,'models.json'),projectStatePath:path.join(root,'projects.json'),projectsRoot:path.join(root,'projects'),seedInitialProject:false,...options});
 const server=createServer((req,res)=>{void bridge.middleware(req,res,()=>{res.writeHead(404);res.end();});});server.on('upgrade',bridge.upgrade);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const request=async(operation,data={},key=token,headers={})=>{
  const response=await fetch(origin+'/__latex/'+operation,{method:'POST',headers:{'Content-Type':'application/json','X-LaTeX-Token':key,...headers},body:JSON.stringify(data)});
  return {status:response.status,value:await response.json()};
 };
 const projects=async data=>{const result=await request('projects',data);assert.equal(result.status,200,JSON.stringify(result.value));return result.value;};
 const session=async id=>{const response=await fetch(origin+'/__latex/session'+(id?'?project='+encodeURIComponent(id):''));return {status:response.status,value:await response.json()};};
 return {root,initial,token,bridge,server,origin,request,projects,session,async close(){bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(root),runtime);await fs.rm(root,{recursive:true,force:true});}};
}

test('opening another project keeps old editor saves, filenames and friendly names bound to the original root',async()=>{
 const f=await fixture();try{
  const a=(await f.projects({action:'create',name:'First paper'})).project,b=(await f.projects({action:'create',name:'Second paper',template:'blank'})).project;
  const opened=await f.projects({action:'open',id:a.id});assert.equal(opened.url,'/latex.html?project='+a.id);
  const sa=(await f.session(a.id)).value;assert.equal(sa.root,a.root);assert.equal(sa.name,'First paper');assert.notEqual(sa.token,f.token);
  assert.equal((await f.request('save',{files:[{name:'main.tex',content:'A before switching'}]},sa.token)).status,200);
  await f.projects({action:'open',id:b.id});const sb=(await f.session(b.id)).value;assert.notEqual(sb.token,sa.token);
  assert.equal((await f.request('save',{files:[{name:'main.tex',content:'A after switching'}]},sa.token)).status,200);
  assert.equal((await f.request('save',{files:[{name:'main.tex',content:'B stays separate'}]},sb.token)).status,200);
  assert.equal(await fs.readFile(path.join(a.root,'main.tex'),'utf8'),'A after switching');assert.equal(await fs.readFile(path.join(b.root,'main.tex'),'utf8'),'B stays separate');
  assert.equal(await fs.readFile(path.join(f.initial,'main.tex'),'utf8'),'initial workspace');
  const currentA=await f.request('project?project='+b.id,{},sa.token);assert.equal(currentA.value.root,a.root);
  assert.equal((await f.session()).value.token,f.token);assert.equal((await f.session()).value.root,f.initial);
 }finally{await f.close();}
});

test('concurrent sessions reuse the same project context and fixed workspaces cannot be redirected through the legacy open endpoint',async()=>{
 const f=await fixture();try{
  const a=(await f.projects({action:'create',name:'A'})).project,b=(await f.projects({action:'create',name:'B'})).project;
  const sessions=await Promise.all(Array.from({length:8},()=>f.session(a.id)));assert.equal(new Set(sessions.map(s=>s.value.token)).size,1);
  const key=sessions[0].value.token;const changed=await f.request('open',{path:b.root},key);assert.equal(changed.status,400);assert.match(changed.value.error,/home|主页|fixed|项目/i);
  assert.equal((await f.request('project',{},key)).value.root,a.root);
  const forged=await f.request('save',{files:[{name:'main.tex',content:'forged'}]},'ff'.repeat(32));assert.equal(forged.status,403);
  assert.equal((await f.request('projects',{action:'create',name:'Wrong capability'},key)).status,403);
 }finally{await f.close();}
});

test('display rename and archive are metadata operations; an existing editor remains able to save archived paper files',async()=>{
 const f=await fixture();try{
  const project=(await f.projects({action:'create',name:'Working paper'})).project,key=(await f.session(project.id)).value.token;
  await f.projects({action:'rename',id:project.id,name:'Renamed paper'});assert.equal((await f.request('project',{},key)).value.name,'Renamed paper');
  await f.projects({action:'archive',id:project.id});assert.equal((await f.session(project.id)).status,400);
  assert.equal((await f.request('save',{files:[{name:'main.tex',content:'Retained draft'}]},key)).status,200);assert.equal(await fs.readFile(path.join(project.root,'main.tex'),'utf8'),'Retained draft');
  await f.projects({action:'restore',id:project.id});assert.equal((await f.session(project.id)).value.token,key);
 }finally{await f.close();}
});

test('project home and project session discovery enforce local same-origin access',async()=>{
 const f=await fixture();try{
  const project=(await f.projects({action:'create',name:'Protected local paper'})).project;
  const denied=await f.request('projects',{action:'list'},f.token,{Origin:'https://untrusted.example'});assert.equal(denied.status,403);
  const session=await fetch(f.origin+'/__latex/session?project='+project.id,{headers:{Origin:'https://untrusted.example'}});assert.equal(session.status,403);
  const crossSite=await fetch(f.origin+'/__latex/session?project='+project.id,{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(crossSite.status,403);
  assert.equal((await f.session('unknown-project')).status,400);
  const noPost=await fetch(f.origin+'/__latex/projects');assert.equal(noPost.status,405);
 }finally{await f.close();}
});

test('model settings share one explicit provider while project file capabilities remain separate',async()=>{
 let reads=0;const provider={async settings(){return {configured:true,model:'shared-local-model',read:++reads};}};
 const f=await fixture({modelProviderInstance:provider});try{
  const a=(await f.projects({action:'create',name:'A'})).project,b=(await f.projects({action:'create',name:'B'})).project;
  const ka=(await f.session(a.id)).value.token,kb=(await f.session(b.id)).value.token;
  assert.equal((await f.request('model-settings',{},ka)).value.read,1);assert.equal((await f.request('model-settings',{},kb)).value.read,2);assert.equal((await f.request('model-settings')).value.read,3);
 }finally{await f.close();}
});

test('an actual initial folder is seeded once, and archiving every project does not create a new fake starter',async()=>{
 const f=await fixture({seedInitialProject:true});try{
  const listed=await f.projects({action:'list'});assert.equal(listed.projects.length,1);assert.equal(listed.projects[0].root,f.initial);
  await f.projects({action:'archive',id:listed.projects[0].id});const again=await f.projects({action:'list'});assert.equal(again.projects.length,1);assert.equal(again.projects[0].archived,true);
  assert.equal(await fs.readFile(path.join(f.initial,'main.tex'),'utf8'),'initial workspace');
 }finally{await f.close();}
});

test('WebSocket upgrades use the matching project capability and reject unknown tokens',async()=>{
 const f=await fixture();let ws;try{
  const project=(await f.projects({action:'create',name:'Realtime capability'})).project,key=(await f.session(project.id)).value.token;
  ws=new WebSocket(f.origin.replace('http:','ws:')+'/__latex/realtime?token='+key,{origin:f.origin});
  const available=await new Promise((resolve,reject)=>{ws.once('message',raw=>resolve(JSON.parse(raw.toString())));ws.once('error',reject);});assert.equal(available.type,'availability');assert.equal(available.active,false);
  await new Promise(resolve=>{ws.once('close',resolve);ws.close();});ws=null;
  const wrong=new WebSocket(f.origin.replace('http:','ws:')+'/__latex/realtime?token=wrong',{origin:f.origin});await new Promise(resolve=>{wrong.once('error',resolve);wrong.once('open',()=>{wrong.close();assert.fail('Unknown token upgraded');});});
 }finally{ws?.close();await f.close();}
});

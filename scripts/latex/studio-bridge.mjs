import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createBridge,defaultProject} from './bridge.mjs';
import {ModelProvider} from './model-provider.mjs';
import {ProjectCatalog} from './projects.mjs';

const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function validOrigin(req){
 if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||''))return false;
 if(req.headers['sec-fetch-site']==='cross-site')return false;
 return !req.headers.origin||req.headers.origin==='http://'+req.headers.host;
}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){
 const chunks=[];let length=0;
 for await(const chunk of req){length+=chunk.length;if(length>24*1024*1024)throw Error('Request exceeds 24 MiB.');chunks.push(chunk);}
 return JSON.parse(Buffer.concat(chunks).toString()||'{}');
}
const sameRoot=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

/** Each project receives a fixed-root bridge and capability token. Opening a
 * second project never redirects an already-open editor's writes or agents. */
export function createStudioBridge({initialProject=defaultProject,sessionToken=randomBytes(32).toString('hex'),modelStatePath=path.join(checkout,'.runtime/model-provider.json'),agentFetch=fetch,modelProviderInstance,projectStatePath,projectsRoot,seedInitialProject=true}={}){
 const catalog=new ProjectCatalog({statePath:projectStatePath,projectsRoot});
 const provider=modelProviderInstance||new ModelProvider(modelStatePath);
 const shared={modelStatePath,agentFetch,modelProviderInstance:provider};
 const portal=createBridge({...shared,initialProject,sessionToken});
 const byId=new Map(),byToken=new Map(),allBridges=new Set([portal]);let closed=false;
 const ready=(async()=>{
  if(!seedInitialProject)return;
  const current=await catalog.list();
  if(!current.projects.length){
   // Register an actual starter/current folder only; seeding never creates paper
   // files, and archived entries still count as an existing index.
   try{await catalog.import({path:path.resolve(initialProject)});}catch{}
  }
 })();
 void ready.catch(()=>{});
 function workspace(project){
  const existing=byId.get(project.id);
  if(existing&&sameRoot(existing.project.root,project.root)){existing.project=project;return existing;}
  const entry={project,token:randomBytes(32).toString('hex'),bridge:null};
  entry.bridge=createBridge({...shared,initialProject:project.root,sessionToken:entry.token,fixedProject:true,projectName:()=>entry.project.name});
  byId.set(project.id,entry);byToken.set(entry.token,entry);allBridges.add(entry.bridge);return entry;
 }
 async function middleware(req,res,next){
  const url=new URL(req.url||'/','http://localhost');
  if(!url.pathname.startsWith('/__latex/'))return next();
  if(closed)return json(res,{error:'The local service is closing.'},503);
  if(!validOrigin(req))return json(res,{error:'Only local same-origin requests are allowed.'},403);
  if(url.pathname==='/__latex/session'&&req.method==='GET'&&url.searchParams.has('project')){
   try{
    const id=url.searchParams.get('project');if(!id||id.length>128)throw Error('Choose a project from the home page.');
    await ready;const entry=workspace(await catalog.open(id));
    return entry.bridge.middleware(req,res,next);
   }catch(error){return json(res,{error:error.message||String(error)},400);}
  }
  if(url.pathname==='/__latex/projects'){
   if(req.method!=='POST')return json(res,{error:'Use POST for project management.'},405);
   if(req.headers['x-latex-token']!==sessionToken)return json(res,{error:'The home session expired. Reload the project list.'},403);
   try{
    const input=await body(req);await ready;const result=await catalog.handle(input);
    if(result.project){
     const entry=byId.get(result.project.id);if(entry&&sameRoot(entry.project.root,result.project.root))entry.project=result.project;
     if(input.action==='open'){
      workspace(result.project);
      return json(res,{...result,url:'/latex.html?project='+encodeURIComponent(result.project.id)});
     }
    }
    return json(res,result);
   }catch(error){return json(res,{error:error.message||String(error)},400);}
  }
  const entry=byToken.get(req.headers['x-latex-token']);
  return (entry?.bridge||portal).middleware(req,res,next);
 }
 function upgrade(req,socket,head){
  const url=new URL(req.url||'/','http://localhost');
  if(!url.pathname.startsWith('/__latex/'))return;
  if(closed||!validOrigin(req)){socket.destroy();return;}
  const entry=byToken.get(url.searchParams.get('token'));
  return (entry?.bridge||portal).upgrade(req,socket,head);
 }
 return {middleware,upgrade,catalog,close(){closed=true;for(const bridge of allBridges)bridge.close();byId.clear();byToken.clear();allBridges.clear();}};
}

export function studioBridge(options={}){
 return {name:'sidex-latex-studio',configureServer(server){
  const bridge=createStudioBridge(options);
  server.middlewares.use((req,res,next)=>{
   const url=new URL(req.url||'/','http://localhost');
   if(url.pathname==='/'||url.pathname==='/home')req.url='/home.html'+url.search;
   return bridge.middleware(req,res,next);
  });
  server.httpServer?.on('upgrade',bridge.upgrade);server.httpServer?.once('close',()=>bridge.close());
 }};
}

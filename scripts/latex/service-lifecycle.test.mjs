import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {installServiceLifecycle} from './service-lifecycle.mjs';
const checkout=fileURLToPath(new URL('../../',import.meta.url)),runtime=path.join(checkout,'.runtime');
const fixture=async()=>{await fs.mkdir(runtime,{recursive:true});return fs.mkdtemp(path.join(runtime,'service-lifecycle-test-'));};
const cleanup=async root=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(runtime));assert(path.basename(root).startsWith('service-lifecycle-test-'));await fs.rm(root,{recursive:true,force:true});};
const rows=async file=>(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
function host(){return Object.assign(new EventEmitter(),{pid:123,ppid:45});}
test('lifecycle records only selected process metadata and never exception or session data',async()=>{
 const root=await fixture(),file=path.join(root,'events.log'),proc=host(),secret='DO_NOT_LOG_SESSION_OR_API_SECRET';
 try{const record=installServiceLifecycle(file,{process:proc,now:()=>new Date('2026-01-01T00:00:00.000Z')});
  record('listening',{port:1421,token:secret});record('signal',{signal:'SIGTERM',body:secret});
  const error=Object.assign(new Error(secret),{name:secret,code:secret});proc.emit('uncaughtExceptionMonitor',error,'unhandledRejection');proc.emit('exit',0);
  const data=await rows(file);assert.deepEqual(data.map(r=>r.event),['startup','listening','signal','fatal','exit']);
  assert(data.every(r=>r.pid===123&&r.ppid===45&&r.at==='2026-01-01T00:00:00.000Z'));
  assert.equal(data[1].port,1421);assert.equal(data[3].origin,'unhandledRejection');assert.equal(data[3].errorType,'Error');assert.equal(data[4].code,0);
  assert.equal((await fs.readFile(file,'utf8')).includes(secret),false);
  assert.equal(proc.listenerCount('uncaughtException'),0);assert.equal(proc.listenerCount('unhandledRejection'),0);
 }finally{await cleanup(root);}
});
test('a blocked lifecycle log is best effort and cannot interrupt startup or exit',async()=>{
 const root=await fixture(),blocked=path.join(root,'blocked');try{await fs.writeFile(blocked,'file');const proc=host();let record;
  assert.doesNotThrow(()=>{record=installServiceLifecycle(path.join(blocked,'log'),{process:proc});});
  assert.equal(record('listening',{port:1421}),false);assert.doesNotThrow(()=>proc.emit('exit',0));assert.doesNotThrow(()=>proc.emit('uncaughtExceptionMonitor',new Error('not logged'),'uncaughtException'));
 }finally{await cleanup(root);}
});
test('an actual fatal error still exits nonzero and its private message never enters lifecycle logs',async()=>{
 const root=await fixture(),file=path.join(root,'fatal.log'),secret='PRIVATE_FATAL_PAYLOAD';
 try{const code='import {installServiceLifecycle} from '+JSON.stringify(new URL('./service-lifecycle.mjs',import.meta.url).href)+';installServiceLifecycle('+JSON.stringify(file)+');setImmediate(()=>{throw new Error('+JSON.stringify(secret)+');});';
  const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:checkout,windowsHide:true,stdio:'ignore'});const result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  assert.notEqual(result.code,0);const data=await rows(file);assert(data.some(r=>r.event==='fatal'&&r.origin==='uncaughtException'));assert(data.some(r=>r.event==='exit'&&r.code!==0));assert.equal((await fs.readFile(file,'utf8')).includes(secret),false);
 }finally{await cleanup(root);}
});
test('service HTTP routes and restored session remain unchanged with lifecycle recording',async()=>{
 const root=await fixture(),probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));assert.notEqual(port,1421);
 const project=path.join(root,'paper'),token='ad'.repeat(32),resume=path.join(root,'resume.json');await fs.mkdir(project);await fs.writeFile(path.join(project,'main.tex'),'test');await fs.writeFile(resume,JSON.stringify({root:project,token}));
 const code='process.argv=[process.execPath,"service","--resume-state",'+JSON.stringify(resume)+'];process.env.SIDEX_PORT='+JSON.stringify(String(port))+';process.env.SIDEX_PROJECTS_STATE='+JSON.stringify(path.join(root,'projects.json'))+';process.env.SIDEX_PROJECTS_DIR='+JSON.stringify(path.join(root,'projects'))+';await import('+JSON.stringify(new URL('./serve.mjs',import.meta.url).href)+');process.on("message",value=>{if(value==="stop"){process.emit("SIGTERM");process.disconnect();}});process.send("loaded");';
 const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:checkout,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let ended=false;child.once('exit',()=>{ended=true;});
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Service startup timed out')),10000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  const url='http://127.0.0.1:'+port;let session;for(let i=0;i<30;i++){try{session=await(await fetch(url+'/__latex/session',{signal:AbortSignal.timeout(1000)})).json();break;}catch{if(ended)break;await new Promise(resolve=>setTimeout(resolve,30));}}
  assert(session);assert.equal(session.token,token);assert.equal(session.root,project);assert.equal((await fetch(url+'/home')).status,200);assert.equal((await fetch(url+'/latex.html')).status,200);assert.equal((await fetch(url+'/not-a-route')).status,404);
  child.send('stop');const result=await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Service shutdown timed out')),10000);timer.unref();})]);assert.equal(result.code,0);
  const data=(await rows(path.join(runtime,'service-lifecycle.log'))).filter(r=>r.pid===child.pid);assert(data.some(r=>r.event==='startup'));assert(data.some(r=>r.event==='listening'&&r.port===port));assert(data.some(r=>r.event==='signal'&&r.signal==='SIGTERM'));assert(data.some(r=>r.event==='exit'&&r.code===0));assert.equal(JSON.stringify(data).includes(token),false);
 }finally{if(!ended){child.kill();await exit;}await cleanup(root);}
});

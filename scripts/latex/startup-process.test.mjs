import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const helper=fileURLToPath(new URL('./startup-process.ps1',import.meta.url));
const quote=s=>"'"+s.replaceAll("'","''")+"'";
async function runFake(code,{timeout=8,heartbeat=1}={}){
 const tempRoot=path.resolve(os.tmpdir()),directory=await mkdtemp(path.join(tempRoot,'sidex-startup-'));
 const fake=path.join(directory,'fake.mjs'),script=path.join(directory,'invoke.ps1');
 await writeFile(fake,code);
 await writeFile(script,`$ErrorActionPreference = 'Stop'
. ${quote(helper)}
try {
 Invoke-StudioProcess -Executable ${quote(process.execPath)} -Arguments @('"'+${quote(fake)}+'"') -WorkingDirectory ${quote(directory)} -OutputFile ${quote(path.join(directory,'out.log'))} -ErrorFile ${quote(path.join(directory,'err.log'))} -Stage 'Test install' -TimeoutSeconds ${timeout} -HeartbeatSeconds ${heartbeat}
 exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`);
 const started=Date.now(),events=[];let stdout='',stderr='';
 const env={...process.env,SystemDrive:process.env.SystemDrive||path.parse(process.env.SystemRoot||'C:/Windows').root.replace(/[\\/]+$/,'')};
 try {
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(path.join(env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,cwd:directory,env});
   child.stdout.on('data',b=>{const s=b.toString();stdout+=s;events.push({text:s,at:Date.now()-started});});
   child.stderr.on('data',b=>{stderr+=b.toString();});child.on('error',reject);
   child.on('exit',exitCode=>resolve({exitCode,stdout,stderr,events,elapsed:Date.now()-started}));
  });return result;
 }finally{if(path.dirname(path.resolve(directory))!==tempRoot)throw Error('Refusing cleanup outside test temp directory');await rm(directory,{recursive:true,force:true});}
}
test('startup streams output before exit and shows quiet progress',{skip:process.platform!=='win32'},async()=>{
 const r=await runFake("console.log('EARLY');setTimeout(()=>console.log('LATE'),2400)");
 assert.equal(r.exitCode,0,r.stderr);assert.match(r.stdout,/EARLY/);assert.match(r.stdout,/LATE/);assert.match(r.stdout,/Still running/);assert.match(r.stdout,/Completed in/);
 const early=r.events.find(e=>e.text.includes('EARLY'));assert.ok(early&&r.elapsed-early.at>1000,'output must arrive while the child is running');
});
test('startup retains nonzero exit code and stderr',{skip:process.platform!=='win32'},async()=>{
 const r=await runFake("console.error('NETWORK_FAILURE');process.exit(7)");
 assert.equal(r.exitCode,1);assert.match(r.stdout,/NETWORK_FAILURE/);assert.match(r.stderr,/exit 7/);assert.match(r.stderr,/Logs:/);
});
test('startup stops its own timed out child',{skip:process.platform!=='win32'},async()=>{
 const r=await runFake("console.log('WAITING');setInterval(()=>{},1000)",{timeout:1});
 assert.equal(r.exitCode,1);assert.match(r.stderr,/exceeded 1s and was stopped/);assert.ok(r.elapsed<15000,'timeout should terminate promptly');
});

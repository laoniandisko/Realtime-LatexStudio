import {existsSync} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),probes=new Map();
async function probeHost(python,host,library){
 const key=python+'\0'+host+'\0'+library;
 if(probes.has(key))return probes.get(key);
 const {stdout}=await run(python,['-X','utf8',host,'--probe','--library',library],{windowsHide:true,timeout:4000,maxBuffer:8192});
 const result=JSON.parse(stdout);if(result.version!=='0.0.6')throw Error('Unsupported realtime-tex library version');
 probes.set(key,result);return result;
}
/** Keep the official CLI available when the optional embedded host is unavailable. */
export async function selectRtexCommand({executable,distribution,checkout,env=process.env,platform=process.platform,probe=probeHost}){
 const mode=env.SIDEX_RTEX_HOST||'auto',fallback={command:executable,prefix:[],kind:'cli'};
 if(!['auto','cli','ffi'].includes(mode))throw Error('SIDEX_RTEX_HOST must be auto, cli or ffi.');
 if(mode==='cli')return fallback;
 const host=path.join(checkout,'scripts/latex/rtex-host.py'),library=path.join(distribution,'lib/rtex_core.dll');
 if(platform!=='win32'||env.SIDEX_RTEX_PATH||!existsSync(host)||!existsSync(library)){
  if(mode==='ffi')throw Error('The realtime-tex embedded host requires the official Windows 0.0.6 library.');
  return fallback;
 }
 const python=env.SIDEX_RTEX_PYTHON||'python';
 try{await probe(python,host,library);}
 catch(error){if(mode==='ffi')throw Error('Unable to start the realtime-tex embedded host: '+String(error.message).slice(0,300));return fallback;}
 return {command:python,prefix:['-X','utf8',host],suffix:['--library',library],kind:'ffi'};
}

import {appendFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
const events=new Set(['startup','listening','signal','exit','fatal']);
const errorTypes=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AggregateError']);
const errorCodes=new Set(['EADDRINUSE','EADDRNOTAVAIL','EACCES','EPERM','ENOENT','ENOMEM','EPIPE','ECONNRESET','EMFILE','ENFILE','ERR_SERVER_NOT_RUNNING','ERR_UNHANDLED_REJECTION']);
/** Private, best-effort diagnostics. Never serialize request data, exception
 * messages, stacks, resume state, credentials, or manuscript contents. */
export function installServiceLifecycle(logPath,{process:host=process,now=()=>new Date()}={}){
 const record=(event,detail={})=>{
  try{
   if(!events.has(event))return false;
   const row={at:now().toISOString(),pid:host.pid,ppid:host.ppid,event};
   if(event==='listening'&&Number.isInteger(detail.port)&&detail.port>0&&detail.port<=65535)row.port=detail.port;
   if(event==='signal'&&['SIGINT','SIGTERM'].includes(detail.signal))row.signal=detail.signal;
   if(event==='exit'&&Number.isInteger(detail.code))row.code=detail.code;
   if(event==='fatal'){
    row.origin=detail.origin==='unhandledRejection'?'unhandledRejection':'uncaughtException';
    row.errorType=errorTypes.has(detail.error?.name)?detail.error.name:'Error';
    if(errorCodes.has(detail.error?.code))row.code=detail.error.code;
   }
   mkdirSync(path.dirname(logPath),{recursive:true});
   appendFileSync(logPath,JSON.stringify(row)+'\n','utf8');return true;
  }catch{return false;}
 };
 host.on('exit',code=>record('exit',{code}));
 // A monitor observes fatal failures without consuming them or changing exit.
 host.on('uncaughtExceptionMonitor',(error,origin)=>record('fatal',{error,origin}));
 record('startup');return record;
}

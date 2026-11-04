export interface AgentChange {path:string;created:boolean;binary:boolean;bytes:number;sha256:string;before:string|null;content?:string}
export interface AgentEvent {type:string;root:string;jobId:string;content?:string;message?:string;name?:string;path?:string;query?:string;id?:string;error?:string;ok?:boolean;change?:AgentChange;changedFiles?:string[];round?:number}
export function shouldSendChatKey(event:Pick<KeyboardEvent,'key'|'shiftKey'|'altKey'|'isComposing'|'keyCode'|'repeat'>){
  return event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.isComposing&&event.keyCode!==229&&!event.repeat;
}
export async function runAgentSession(token:string,data:unknown,signal:AbortSignal,onEvent:(event:AgentEvent)=>void,fetcher:typeof fetch=fetch){
  const response=await fetcher('/__latex/chat',{method:'POST',headers:{'Content-Type':'application/json','X-LaTeX-Token':token},body:JSON.stringify({...data as object,stream:true}),signal});
  if(!response.ok){const value=await response.json();throw Error(value.error||`HTTP ${response.status}`);}
  if(!response.body)throw Error('智能体响应为空。');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',done=false;
  try{while(true){const chunk=await reader.read();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const event=JSON.parse(line) as AgentEvent;onEvent(event);if(event.type==='error')throw Error(event.message||'智能体执行失败');if(event.type==='done')done=true;}
    if(chunk.done)break;
  }if(!done)throw Error('智能体连接提前结束，已收到的文件改动已保留。');}finally{reader.releaseLock();}
}

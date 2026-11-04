// Only a synthetic disposable project is exposed to the model.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBridge} from './bridge.mjs';
const real=process.env.SIDEX_AGENT_REAL_MODEL==='1',output=path.resolve('.runtime/agent-integration');await fs.mkdir(output,{recursive:true});
const root=await fs.mkdtemp(path.join(output,'project-'));await fs.mkdir(path.join(root,'chapter'));await fs.mkdir(path.join(root,'notes'));
await fs.writeFile(path.join(root,'main.tex'),'\\documentclass{article}\n\\begin{document}\\input{chapter/one}\\end{document}\n');await fs.writeFile(path.join(root,'chapter/one.tex'),'Agent phrase: ALPHA\n');await fs.writeFile(path.join(root,'notes/task.md'),'Change ALPHA to BETA in chapter/one.tex.');
let round=0;
const mock=async(url,options)=>{
 const body=JSON.parse(options.body);assert(body.messages.some(m=>Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url')));
 const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});let message;
 if(round++===0)message={role:'assistant',content:null,tool_calls:[call('read-task','read_file',{path:'notes/task.md'}),call('read-chapter','read_file',{path:'chapter/one.tex'})]};
 else if(round===2){const read=JSON.parse(body.messages.find(m=>m.tool_call_id==='read-chapter').content);message={role:'assistant',content:null,tool_calls:[call('edit','edit_file',{path:read.path,find:'ALPHA',replace:'BETA',expected_sha256:read.sha256}),call('write','write_file',{path:'notes/image-color.txt',content:'red'})]};}
 else message={role:'assistant',content:'已修改章节并记录图片主色。'};
 return {ok:true,json:async()=>({choices:[{message}]})};
};
const state=path.join(output,'mock-provider.json');if(!real)await fs.writeFile(state,JSON.stringify({baseUrl:'http://127.0.0.1:9/v1',model:'mock',models:[{id:'mock',kind:'chat'}]}));
const bridge=createBridge(real?{}:{modelStatePath:state,agentFetch:mock}),server=createServer((req,res)=>bridge.middleware(req,res,()=>res.end()));server.on('upgrade',bridge.upgrade);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,session=await(await fetch(origin+'/__latex/session')).json(),headers={'Content-Type':'application/json','X-LaTeX-Token':session.token};
const api=async(name,data={})=>await(await fetch(origin+'/__latex/'+name,{method:'POST',headers,body:JSON.stringify(data)})).json();
try{
 await api('open',{path:root});const settings=real?await api('model-settings'):null;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABLUlEQVR4nO3TMREAMAwDsST8ObcwtLwIePjzvol0dD0F0HoAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAKM9QHP4QH/xCXf5QAAAABJRU5ErkJggg==','base64'),image='data:image/png;base64,'+png.toString('base64'),started=performance.now();
 const response=await fetch(origin+'/__latex/chat',{method:'POST',headers,body:JSON.stringify({stream:true,messages:[{role:'user',content:[{type:'text',text:'请调用工具读取 notes/task.md 和 chapter/one.tex，按 task.md 把 ALPHA 改成 BETA。再查看附图，把图片主色以一个英文单词写入 notes/image-color.txt。不要修改 main.tex 或其他文件。请实际完成文件写入，再简要列出修改路径。'},{type:'image_url',image_url:{url:image}}]}],documents:[],file:'main.tex'}),signal:AbortSignal.timeout(210000)});assert(response.ok);assert(response.headers.get('content-type').includes('ndjson'));
 const reader=response.body.getReader(),decoder=new TextDecoder(),events=[];let buffer='';
 while(true){const value=await reader.read();buffer+=decoder.decode(value.value,{stream:!value.done});let end;
  while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const event=JSON.parse(line);events.push(event);if(['tool-start','tool-end','file-change','done','error'].includes(event.type))console.log(JSON.stringify({type:event.type,tool:event.name,path:event.path||event.change?.path,error:event.message||event.error}));if(event.type==='error')throw Error(event.message);}
  if(value.done)break;
 }
 assert(events.some(e=>e.type==='done'));assert(events.filter(e=>e.type==='file-change').length>=2);assert.equal(await fs.readFile(path.join(root,'chapter/one.tex'),'utf8'),'Agent phrase: BETA\n');
 const color=await fs.readFile(path.join(root,'notes/image-color.txt'),'utf8');assert(/\bred\b/i.test(color));
 assert.equal(await fs.readFile(path.join(root,'main.tex'),'utf8'),'\\documentclass{article}\n\\begin{document}\\input{chapter/one}\\end{document}\n');
 const result={realModel:real,model:settings?.model||'mock',durationMs:Math.round(performance.now()-started),crossFileReadWrite:true,imagePassedToModel:true,imageRecognizedAsRed:true,changes:events.filter(e=>e.type==='file-change').map(e=>e.change.path)};await fs.writeFile(path.join(output,real?'real-result.json':'mock-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));}

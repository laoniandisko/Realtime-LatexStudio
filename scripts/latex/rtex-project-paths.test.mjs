import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {realtimeProjectPaths,externalRealtimeDependency,realtimeDiagnosticPaths} from './rtex-project-paths.mjs';
import {RealtimeManager} from './realtime.mjs';
test('native scope follows a nested main while editor source keys remain project relative',()=>{
 const p=realtimeProjectPaths('/project','paper/main.tex',{pathApi:path.posix});
 assert.equal(p.nativeRoot,'/project/paper');assert.equal(p.nativeMain,'main.tex');
 assert.equal(p.toNative('paper/chapter/body.tex'),'chapter/body.tex');
 assert.equal(p.toProject('chapter/body.tex'),'paper/chapter/body.tex');
 assert.equal(p.toProject('/project/paper/chapter/body.tex'),'paper/chapter/body.tex');
 assert.equal(p.toNative('other/main.tex'),null);assert.equal(p.toProject('../secret.tex'),null);
 assert.equal(p.toNative('paper/../../secret.tex'),null);
});
test('flat and Windows paths preserve Unicode, spaces and distinct neighbouring directory names',()=>{
 const flat=realtimeProjectPaths('/project','main.tex',{pathApi:path.posix});assert.equal(flat.toNative('section/body.tex'),'section/body.tex');assert.equal(flat.cacheName,'');
 const p=realtimeProjectPaths('C:\\work\\项目','paper notes/main.tex',{pathApi:path.win32});
 assert.equal(p.nativeRoot,'C:\\work\\项目\\paper notes');assert.equal(p.toNative('paper notes/章节.tex'),'章节.tex');
 assert.equal(p.toNative('paper notes2/章节.tex'),null);assert.equal(p.toProject('C:\\work\\项目\\paper notes\\章节.tex'),'paper notes/章节.tex');
 assert.equal(p.toProject('D:\\elsewhere\\body.tex'),null);assert.throws(()=>realtimeProjectPaths('/project','../main.tex'),/Invalid/);
});
test('escaping active inputs or graphic paths fall back, while unrelated templates are ignored',()=>{
 const main='\\documentclass{article}\\input{chapter/body}';
 assert.equal(externalRealtimeDependency('paper/main.tex',[{name:'paper/main.tex',content:main},{name:'paper/chapter/body.tex',content:'\\input{../shared}'}]),'../shared');
 assert.equal(externalRealtimeDependency('paper/main.tex',[{name:'paper/main.tex',content:main},{name:'other/main.tex',content:'\\input{../shared}'}]),null);
 assert.equal(externalRealtimeDependency('paper/main.tex',[{name:'paper/main.tex',content:'\\graphicspath{{figures/}{../shared/}}'}]),'../shared/');
 assert.equal(externalRealtimeDependency('paper/main.tex',[{name:'paper/main.tex',content:'% \\input{../ignored}\nText'}]),null);
});
test('only known source diagnostic files are translated, never display list resources or IDs',()=>{
 const p=realtimeProjectPaths('/project','paper/main.tex',{pathApi:path.posix}),known=['paper/main.tex','paper/chapter/body.tex'];
 const dl={items:[{font:{filename:'/fonts/x.otf'},image:{file:'figure.pdf'},par_id:41}]};
 const mapped=realtimeDiagnosticPaths({event:'ParagraphUpdate',par_id:41,dl,diagnostics:[{file:'chapter/body.tex'},{file:'/fonts/x.otf'}]},p,known);
 assert.equal(mapped.diagnostics[0].file,'paper/chapter/body.tex');assert.equal(mapped.diagnostics[1].file,'/fonts/x.otf');
 assert.equal(mapped.dl,dl);assert.equal(mapped.par_id,41);
 assert.equal(realtimeDiagnosticPaths({event:'Diagnostics',items:[{file:'main.tex'}]},p,known).items[0].file,'paper/main.tex');
});
test('commands use native keys, but acknowledgments and source snapshots retain editor keys',()=>{
 const m=new RealtimeManager(()=>'/project',async f=>f),sent=[];
 m.nativePaths=realtimeProjectPaths('/project','paper/main.tex',{pathApi:path.posix});m.documentTexts.set('paper/chapter/body.tex','A paragraph.');
 m.child={stdin:{writable:true,write:s=>sent.push(JSON.parse(s))}};m.applyDocument({file:'paper/chapter/body.tex',text:'A revised paragraph.',sequence:9});
 assert.equal(sent[0].cmd,'edit');assert.equal(sent[0].path,'chapter/body.tex');assert.equal(sent[1].path,'chapter/body.tex');
 assert.equal(m.commands[0].file,'paper/chapter/body.tex');assert.equal(m.commands[1].source,'A revised paragraph.');
});
test('editing an unrelated file releases the frontend queue without sending unknown paths to native',async()=>{
 const m=new RealtimeManager(()=>'/project',async f=>f),sent=[],packets=[];
 m.nativePaths=realtimeProjectPaths('/project','paper/main.tex',{pathApi:path.posix});m.child={stdin:{writable:true,write:s=>sent.push(s)}};m.send=p=>packets.push(p);
 await m.handle({type:'document',file:'other/main.tex',text:'Unrelated draft',sequence:18});
 assert.deepEqual(sent,[]);assert.equal(packets[0].type,'document-ack');assert.equal(packets[0].sequence,18);
 assert.equal(packets[0].route,'inactive-document');assert.equal(packets[0].error,undefined);assert.equal(m.documentTexts.get('other/main.tex'),'Unrelated draft');
});

test('nested native sessions bind child sources to UI keys and keep sibling drafts separate',{skip:process.env.SIDEX_RTEX_NATIVE_TEST!=='1'},async()=>{
 const fs=await import('node:fs/promises'),{createServer}=await import('node:http'),{WebSocket}=await import('ws'),{createBridge}=await import('./bridge.mjs');
 const runtime=path.resolve('.runtime');await fs.mkdir(runtime,{recursive:true});const root=await fs.mkdtemp(path.join(runtime,'nested-main-'));
 const main='\\documentclass{article}\n\\usepackage{times}\n\\setlength{\\pdfpagewidth}{8.5in}\n\\setlength{\\pdfpageheight}{11in}\n\\begin{document}\n\\input{chapter/body}\n\\end{document}\n';
 const body='A paragraph in a nested chapter keeps its own source range. It can be edited without changing the selected project or any other paper. The native engine must register this child file under its main directory.\n';
 await fs.mkdir(path.join(root,'paper/chapter'),{recursive:true});await fs.mkdir(path.join(root,'other'));await fs.writeFile(path.join(root,'paper/main.tex'),main);await fs.writeFile(path.join(root,'paper/chapter/body.tex'),body);await fs.writeFile(path.join(root,'other/main.tex'),'Unrelated paper draft');
 const bridge=createBridge({initialProject:root,modelStatePath:path.join(root,'.models.json')}),server=createServer((req,res)=>bridge.middleware(req,res,()=>res.end()));server.on('upgrade',bridge.upgrade);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port,session=await(await fetch(origin+'/__latex/session')).json(),headers={'content-type':'application/json','x-latex-token':session.token};
 const project=await(await fetch(origin+'/__latex/project',{method:'POST',headers,body:'{}'})).json(),events=[];let failure;
 const ws=new WebSocket(origin.replace('http:','ws:')+'/__latex/realtime?token='+session.token,{origin});ws.on('error',e=>{failure=e;});ws.on('message',raw=>{const e=JSON.parse(raw.toString());events.push(e);if(e.type==='error'||e.type==='document-ack'&&e.error)failure=Error(e.message||e.error);});
 const send=p=>ws.send(JSON.stringify(p));const wait=async predicate=>{const start=Date.now();while(Date.now()-start<20000){if(failure)throw failure;if(predicate())return;await new Promise(r=>setTimeout(r,3));}throw Error('Nested native regression timed out');};
 try{
  await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});send({type:'start',main:'paper/main.tex',documents:project.files});
  await wait(()=>events.some(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.pdf)&&events.some(e=>e.type==='spans'&&e.file==='paper/chapter/body.tex'&&e.spans.length));
  const initial=events.find(e=>e.value?.event==='LayoutUpdate'&&e.pdf);assert.equal(initial.value.pages_total,1);
  const pdf=await fetch(origin+'/__latex/realtime-pdf?generation='+initial.pdf.generation+'&layout='+initial.pdf.layout,{headers});assert.equal(pdf.status,200);assert(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
  send({type:'document',file:'paper/chapter/body.tex',text:body.replace('own source','original source'),sequence:101});
  await wait(()=>events.some(e=>e.type==='document-ack'&&e.sequence===101)&&events.some(e=>e.value?.event==='ParagraphUpdate'&&['ok','ok_degraded'].includes(e.value.status))&&events.some(e=>e.type==='spans'&&e.file==='paper/chapter/body.tex'&&e.source.includes('original source')));
  assert.equal(events.find(e=>e.type==='document-ack'&&e.sequence===101).file,'paper/chapter/body.tex');
  send({type:'document',file:'other/main.tex',text:'Unsaved sibling draft',sequence:102});await wait(()=>events.some(e=>e.type==='document-ack'&&e.sequence===102));assert.equal(events.find(e=>e.type==='document-ack'&&e.sequence===102).route,'inactive-document');
  assert.equal(await fs.readFile(path.join(root,'paper/main.tex'),'utf8'),main);assert.equal(await fs.readFile(path.join(root,'paper/chapter/body.tex'),'utf8'),body);assert.equal(await fs.readFile(path.join(root,'other/main.tex'),'utf8'),'Unrelated paper draft');
 }finally{if(ws.readyState===1){const count=events.length;send({type:'stop'});const end=Date.now()+8000;while(Date.now()<end&&!events.slice(count).some(e=>e.type==='state'&&e.state==='stopped'))await new Promise(r=>setTimeout(r,10));}ws.close();bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(root),runtime);await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('different mains keep snapshot caches separate even when they share the same project',()=>{const a=realtimeProjectPaths('/project','paperA/main.tex',{pathApi:path.posix}),b=realtimeProjectPaths('/project','paperB/main.tex',{pathApi:path.posix}),c=realtimeProjectPaths('/project','paperA/supplement.tex',{pathApi:path.posix});assert.notEqual(a.cacheName,b.cacheName);assert.notEqual(a.cacheName,c.cacheName);assert.equal(a.cacheName,realtimeProjectPaths('/project','paperA/main.tex',{pathApi:path.posix}).cacheName);assert.match(a.cacheName,/^main-[0-9a-f]{20}$/);});

test('custom class and style chains cannot hide an external shared dependency',()=>{const docs=[{name:'paper/main.tex',content:'\\documentclass{custom}'},{name:'paper/custom.cls',content:'\\LoadClass{article}\\RequirePackageWithOptions{settings}'},{name:'paper/settings.sty',content:'\\input{../shared}'}];assert.equal(externalRealtimeDependency('paper/main.tex',docs),'../shared');});

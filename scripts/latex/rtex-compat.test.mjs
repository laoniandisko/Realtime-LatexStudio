import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {prepareRtexTexdir,prepareRtexLatexRunner,needsLegacyOt1} from './rtex-compat.mjs';
import {execFile,spawn} from 'node:child_process';

const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const originalLabels=`    local n = 0
    for _, kv in ipairs(req.labels or {}) do
      token.set_macro(kv[1], kv[2], "global")
      n = n + 1
    end
    send{ op = "ok", id = n }`;
async function sandbox(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidex-rtex-compat-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const source=path.join(root,'source'),cache=path.join(root,'cache');
 await fs.mkdir(path.join(source,'latex'),{recursive:true});
 const serve='-- rtex 0.0.6 fixture\n'+originalLabels+'\n';
 await fs.writeFile(path.join(source,'rtex-serve.lua'),serve);
 const dl=String.raw`function State:emit(item)
  if self.bin then
      self:bin_rec(0x28, pack("<Bi4i4", op, item[3], item[4]) .. bstr(item[5]))
    end
    return
  end
  local tgt = self.cur and self.cur.items or self.other
  tgt[#tgt + 1] = item
end
function State:flag(kind, detail)
end
`;
 await fs.writeFile(path.join(source,'rtex-dl.lua'),dl);

 await fs.writeFile(path.join(source,'latex','helper.tex'),'original helper\n');
 return {root,source,cache,serve,dl};
}

test('copies assets and installs real TeX tokenization without changing the distribution',async t=>{
 const {source,cache,serve,dl}=await sandbox(t),prepared=await prepareRtexTexdir(source,cache);
 assert.equal(await fs.readFile(path.join(source,'rtex-dl.lua'),'utf8'),dl);
 const emitted=await fs.readFile(path.join(prepared,'rtex-dl.lua'),'utf8');
 assert(emitted.includes('self:bin_rec(0x21, pack(\"<i4i4i4i4\", 0, 0, 0, 0))'));
 assert(emitted.includes('if item[1] == \"M\" then tgt[#tgt + 1] = { \"r\", 0, 0, 0, 0 } end'));
 assert.equal(path.dirname(prepared),cache);
 assert.equal(await fs.readFile(path.join(source,'rtex-serve.lua'),'utf8'),serve);
 assert.equal(await fs.readFile(path.join(prepared,'latex','helper.tex'),'utf8'),'original helper\n');
 const patched=await fs.readFile(path.join(prepared,'rtex-serve.lua'),'utf8');
 assert(patched.includes('tex.runtoks(function() tex.print(S.cct, lines) end)'));
 assert(patched.includes('\\\\global\\\\expandafter\\\\def\\\\csname '));
 assert(!patched.includes('token.set_macro(kv[1]'));
 assert(!patched.includes('gsub("~"'));
});

test('concurrent publication and repeated preparation reuse one complete cache',async t=>{
 const {source,cache}=await sandbox(t);
 const prepared=await Promise.all(Array.from({length:8},()=>prepareRtexTexdir(source,cache)));
 assert.equal(new Set(prepared).size,1);
 assert.equal(await prepareRtexTexdir(source,cache),prepared[0]);
 assert.deepEqual(await fs.readdir(cache),[path.basename(prepared[0])]);
});

test('the content address includes all upstream assets and preserves old copies',async t=>{
 const {source,cache}=await sandbox(t),before=await prepareRtexTexdir(source,cache);
 await fs.writeFile(path.join(source,'latex','helper.tex'),'changed helper\n');
 const after=await prepareRtexTexdir(source,cache);
 assert.notEqual(after,before);
 assert.equal(await fs.readFile(path.join(before,'latex','helper.tex'),'utf8'),'original helper\n');
 assert.equal(await fs.readFile(path.join(after,'latex','helper.tex'),'utf8'),'changed helper\n');
});

test('an already patched directory is recognized and its scanner is not patched twice',async t=>{
 const {source,cache}=await sandbox(t),first=await prepareRtexTexdir(source,cache);
 const second=await prepareRtexTexdir(first,cache);
 const content=await fs.readFile(path.join(second,'rtex-serve.lua'),'utf8');
 assert.equal(content,await fs.readFile(path.join(first,'rtex-serve.lua'),'utf8'));
 assert.equal(content.split('-- SideX aux-tokenizer-v1:').length,2);
 const emitted=await fs.readFile(path.join(second,'rtex-dl.lua'),'utf8');
 assert.equal(emitted,await fs.readFile(path.join(first,'rtex-dl.lua'),'utf8'));
 assert.equal(emitted.split('-- SideX matrix-codec-padding-v1:').length,2);
 assert.equal(await prepareRtexTexdir(first,cache),second);
});

test('unrecognized scanners and damaged published copies fail visibly',async t=>{
 const {source,cache}=await sandbox(t),prepared=await prepareRtexTexdir(source,cache);
 await fs.writeFile(path.join(prepared,'rtex-serve.lua'),'damaged cache');
 await assert.rejects(prepareRtexTexdir(source,cache));
 assert.equal(await fs.readFile(path.join(prepared,'rtex-serve.lua'),'utf8'),'damaged cache');
 await fs.writeFile(path.join(source,'rtex-serve.lua'),'a different upstream scanner');
 await assert.rejects(prepareRtexTexdir(source,cache),/Unsupported realtime-tex aux-label scanner/);
});

test('a missing cached dependency cannot pass verification with an intact scanner',async t=>{
 const {source,cache}=await sandbox(t),prepared=await prepareRtexTexdir(source,cache);
 await fs.unlink(path.join(prepared,'latex','helper.tex'));
 await assert.rejects(prepareRtexTexdir(source,cache),/Incomplete or corrupted realtime-tex compatibility cache/);
 assert.deepEqual(await fs.readdir(cache),[path.basename(prepared)]);
});

// Optional real-engine regression: SIDEX_RTEX_NATIVE_TEST=1 node --test scripts/latex/rtex-compat.test.mjs
// It creates its own fixture and ephemeral bridge; no user project or service is used.
test('native natbib whitespace and word edits match authoritative full-layout geometry',{
 skip:process.env.SIDEX_RTEX_NATIVE_TEST!=='1',timeout:60000,
},async t=>{
 const {WebSocket}=await import('ws');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidex-rtex-native-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const upstream=process.env.SIDEX_RTEX_NATIVE_TEXDIR||path.join(checkout,'.runtime/rtex/bin/rtex-0.0.6-x86_64-pc-windows-msvc/share/rtex/tex');
 const prepared=await prepareRtexTexdir(upstream,path.join(root,'compat'));
 const before=process.env.SIDEX_RTEX_TEXDIR,beforeHost=process.env.SIDEX_RTEX_HOST;
 process.env.SIDEX_RTEX_HOST='ffi';
 process.env.SIDEX_RTEX_TEXDIR=prepared;
 t.after(()=>{if(before===undefined)delete process.env.SIDEX_RTEX_TEXDIR;else process.env.SIDEX_RTEX_TEXDIR=before;if(beforeHost===undefined)delete process.env.SIDEX_RTEX_HOST;else process.env.SIDEX_RTEX_HOST=beforeHost;});
 const {createBridge}=await import('./bridge.mjs');
 const project=path.join(root,'project');await fs.mkdir(project);
 const paragraph=String.raw`The data model supports stable reconstruction and a consistent comparison of reference methods.
It preserves the original paragraph structure while references such as \citep{alpha} remain intact.
Additional observations connect the \emph{local} state with the \textbf{global} reconstruction,
and the same reasoning applies to the alternatives discussed by \citet{beta}.
We preserve source commands, citation labels, ordinary spaces and punctuation during each edit.
The long paragraph repeats its evidence across several sentences so that \citep{alpha,beta}
must participate in ordinary line breaking rather than splitting the paragraph into fragments.
This final sentence checks that the remainder remains connected after author names and dates.`;
 const source=String.raw`\documentclass[twocolumn]{article}
\usepackage{times,graphicx}
\usepackage[authoryear,round]{natbib}
\setlength{\pdfpagewidth}{8.5in}
\setlength{\pdfpageheight}{11in}
\ifx\pdfpagewidth\pagewidth\else\errmessage{page width is not a dimension alias}\fi
\ifx\pdfpageheight\pageheight\else\errmessage{page height is not a dimension alias}\fi
\begin{document}
\section{Verification}

${paragraph}

Before\scalebox{1.25}[1.1]{Scaled}After.

A separate paragraph follows the editable unit and must retain its position.

\begin{thebibliography}{9}
\bibitem[Alpha et~al.(2024)]{alpha} A. Alpha. A first reference. 2024.
\bibitem[Beta et~al.(2025)]{beta} B. Beta. A second reference. 2025.
\end{thebibliography}
\end{document}
`;
 await fs.writeFile(path.join(project,'main.tex'),source);
 const bridge=createBridge(),server=createServer((req,res)=>bridge.middleware(req,res,()=>res.end()));
 server.on('upgrade',bridge.upgrade);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const session=await(await fetch(origin+'/__latex/session')).json();
 const headers={'Content-Type':'application/json','X-LaTeX-Token':session.token};
 const opened=await(await fetch(origin+'/__latex/open',{method:'POST',headers,body:JSON.stringify({path:project})})).json();
 assert(opened.files?.length);
 const ws=new WebSocket(origin.replace('http:','ws:')+'/__latex/realtime?token='+session.token,{origin});
 const events=[];let failure;
 ws.on('message',raw=>{const packet=JSON.parse(raw.toString());events.push(packet);if(packet.type==='error')failure=Error(packet.message);});
 const wait=async predicate=>{const start=Date.now();while(Date.now()-start<45000){if(failure)throw failure;const result=predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,3));}throw Error('Native compatibility test timed out');};
 try{
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'start',main:'main.tex',documents:opened.files}));
  const initial=await wait(()=>events.find(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.pdf));
  // The C ABI 0.0.6 encoder advances twice after M. Without capture padding,
  // consecutive save/set commands and the first glyph after restore disappear.
  const initialItems=initial.value.pages_changed.flatMap(page=>[...(page.dl.other||[]),...page.dl.lines.flatMap(line=>line.items)]);
   const fontNames=initial.value.pages_changed.flatMap(page=>Object.values(page.dl.fonts||{}).map(font=>font.name));
   assert(fontNames.some(name=>/ptm|NimbusRom/i.test(name)),'legacy Times roman fell back to a modern default');
  const matrices=initialItems.filter(item=>item[0]==='M');
  assert(matrices.some(item=>item[1]==='set'),'the matrix operand was lost in the C ABI display list');
  assert.deepEqual(matrices.slice(0,3).map(item=>item[1]),['save','set','restore']);
  const glyphText=initialItems.filter(item=>item[0]==='g').map(item=>String.fromCodePoint(item[2])).join('');
  assert(glyphText.includes('BeforeScaledAfter.'),'a post-matrix glyph was lost in the C ABI display list');
  const binding=await wait(()=>events.find(e=>e.type==='spans'&&e.file==='main.tex'&&e.spans.some(p=>Buffer.from(e.source).subarray(p.range.start,p.range.end).toString('utf8').includes('The data model'))));
  const span=binding.spans.find(p=>Buffer.from(binding.source).subarray(p.range.start,p.range.end).toString('utf8').includes('The data model'));
  const placement=initial.value.placements.find(p=>p.par_id===span.id);assert(placement);
  const layoutRows=(value,placed)=>placed.fragments.flatMap(fragment=>{
   const page=value.pages_changed.find(page=>page.page===fragment.page);assert(page);
   return fragment.baselines.map((y,k)=>({dl:page.dl,line:page.dl.lines.find(line=>Math.abs(line.y-y)<64&&Math.abs(line.x-(fragment.xs[k]??fragment.x))<64)}));
  });
  const baseline=layoutRows(initial.value,placement);
  assert(baseline.length>3&&baseline.every(row=>row.line));
  const normalize=(dl,line,ignoreCharacter=false)=>({
   // Fast DL transports glue_set as float32; the JSON capture prints its decimal
   // expansion with occasionally one extra double-precision ULP. All sp stay exact.
   w:line.w,h:line.h,d:line.d,gs:Math.fround(line.gs),gsign:line.gsign,gorder:line.gorder,
   glyphs:line.items.filter(item=>item[0]==='g').map(item=>[dl.fonts[String(item[1])].name,ignoreCharacter?null:item[2],item[4]-line.x,item[5]-line.y,item[6],item[7]]),
  });
  const originalGeometry=baseline.map(row=>normalize(row.dl,row.line));
  const originalPositions=baseline.map(row=>normalize(row.dl,row.line,true));
  let sequence=0;
  for(const [name,text] of [
   ['whitespace',source.replace('The data model','The  data model')],
   ['word replacement',source.replace('The data model','The date model')],
   ['restore',source],
  ]){
   const count=events.length,id=++sequence;
   ws.send(JSON.stringify({type:'document',file:'main.tex',text,sequence:id}));
   const ack=await wait(()=>events.slice(count).find(e=>e.type==='document-ack'&&e.sequence===id));
   assert.equal(ack.route,'fast',name);
   const update=(await wait(()=>events.slice(count).find(e=>e.value?.event==='ParagraphUpdate'&&e.value.par_id===span.id&&e.value.versions.source_revision>=ack.revision))).value;
   assert.equal(update.status,'ok',name);
   assert(update.fragments.every(fragment=>!fragment.approximate),name);
   const geometry=update.dl.lines.map(line=>normalize(update.dl,line));
   assert.equal(update.dl.lines.length,baseline.length,name);
   if(name==='word replacement'){
    assert.notDeepEqual(geometry,originalGeometry);
    // A real replacement may change glue and glyph positions. Check it against
    // a full TeX pass of the same revision, rather than assuming equal font metrics.
    const previous=events.length;
    ws.send(JSON.stringify({type:'layout'}));
    const full=(await wait(()=>events.slice(previous).find(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.value.versions.source_revision>=ack.revision))).value;
    const placed=full.placements.find(p=>p.par_id===span.id);assert(placed);
    assert.deepEqual(geometry,layoutRows(full,placed).map(row=>normalize(row.dl,row.line)),name);
   }else{
    assert.deepEqual(update.dl.lines.map(line=>normalize(update.dl,line,true)),originalPositions,name);
    assert.deepEqual(geometry,originalGeometry,name);
   }
   t.diagnostic(`${name}: ${update.dl.lines.length} exact rows; native ${(update.timing.total_us/1000).toFixed(3)} ms`);
  }
  assert.equal(await fs.readFile(path.join(project,'main.tex'),'utf8'),source,'project source was changed on disk');
 }finally{
  if(ws.readyState===1)ws.send(JSON.stringify({type:'stop'}));
  ws.close();await bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
});

test('an unknown or partially modified matrix writer fails rather than silently losing drawing state',async t=>{
 const {source,cache}=await sandbox(t);await fs.writeFile(path.join(source,'rtex-dl.lua'),'return {}');
 await assert.rejects(prepareRtexTexdir(source,cache),/Unsupported realtime-tex matrix emitter/);
});


test('legacy OT1 detection follows only the selected preamble and respects explicit fonts',()=>{
 const files=[{name:'paper/main.tex',content:String.raw`\documentclass{article}
\input{font-setup}
\begin{document}
\usepackage{fontspec}
`},{name:'paper/font-setup.tex',content:String.raw`\usepackage{times,helvet,courier}`},{name:'unrelated.tex',content:String.raw`\usepackage{fontspec}`}];
 assert.equal(needsLegacyOt1('paper/main.tex',files),true);
 assert.equal(needsLegacyOt1('main.tex',[{name:'main.tex',content:String.raw`\usepackage{helvet,courier}`}]),false);
 assert.equal(needsLegacyOt1('main.tex',[{name:'main.tex',content:String.raw`\documentclass{custom}\usepackage{times}`},{name:'custom.cls',content:String.raw`\RequirePackage{fontspec}`}]),false);
 for(const explicit of [String.raw`\usepackage[T1]{fontenc}`,String.raw`\RequirePackage{fontspec}`,String.raw`\usepackage{unicode-math}`,String.raw`\def\encodingdefault{T1}`,String.raw`\fontencoding{T1}`])assert.equal(needsLegacyOt1('paper/main.tex',[files[0],{name:'paper/font-setup.tex',content:files[1].content+'\n'+explicit}]),false,explicit);
 assert.equal(needsLegacyOt1('main.tex',[{name:'main.tex',content:String.raw`% \usepackage{times}
\documentclass{article}
\begin{document}
\usepackage{mathptmx}`}]),false);
 assert.equal(needsLegacyOt1('main.tex',[{name:'main.tex',content:String.raw`\usepackage{mathptmx} % \usepackage{fontspec}
\begin{document}`}]),true);
});

const execute=(file,args,options={})=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:15000,...options},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr})));
async function fakeLatex(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidex-runner-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const tools=path.join(root,'TeX 工具 with spaces');await fs.mkdir(tools);
 const executable=path.join(tools,'lualatex.exe'),source=path.join(root,'fake.cs');
 await fs.writeFile(source,String.raw`using System; using System.IO; using System.Text; using System.Threading; using System.Diagnostics;
class FakeLaTeX { static int Main(string[] args) {
 if(args.Length>0 && args[0]=="--wait-child"){Thread.Sleep(Timeout.Infinite);return 0;}
 string pidfile=Environment.GetEnvironmentVariable("SIDEX_RUNNER_TEST_PIDFILE");
 if(!String.IsNullOrEmpty(pidfile)){
  var start=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"--wait-child");start.UseShellExecute=false;start.CreateNoWindow=true;
  var child=Process.Start(start);File.WriteAllText(pidfile,Process.GetCurrentProcess().Id+" "+child.Id);Thread.Sleep(Timeout.Infinite);return 0;
 }
 foreach(var arg in args)Console.Error.WriteLine("ARG:"+Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));
 Console.OpenStandardInput().CopyTo(Console.OpenStandardOutput());
 return Environment.GetEnvironmentVariable("SIDEX_RUNNER_TEST_EXIT")=="7"?7:0;
} }`);
 const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 await execute(compiler,['/nologo','/target:exe','/out:'+executable,source]);
 return {root,executable,compiler,cache:path.join(root,'cache 中文 with spaces')};
}
function throughRunner(executable,args,env,input=Buffer.alloc(0)){
 return new Promise((resolve,reject)=>{const child=spawn(executable,args,{windowsHide:true,env,stdio:'pipe'}),out=[],err=[];child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));child.once('error',reject);child.once('exit',code=>resolve({code,stdout:Buffer.concat(out),stderr:Buffer.concat(err).toString('utf8')}));child.stdin.end(input);});
}

test('Windows runner preserves byte pipes, Unicode and quoting, exit codes, and atomic cache',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const {root,executable,compiler,cache}=await fakeLatex(t);
 const bins=await Promise.all(Array.from({length:4},()=>prepareRtexLatexRunner(executable,cache,{compiler})));
 assert.equal(new Set(bins).size,1);assert.equal(await prepareRtexLatexRunner(executable,cache,{compiler}),bins[0]);
 const runner=path.join(bins[0],'lualatex.exe'),args=['-interaction=batchmode','-output-directory='+path.join(root,'dir 中文 with spaces')+'\\',String.raw`\directlua{tex.print("quoted") }\input{paper.tex}`];
 const bytes=Buffer.from([0,1,10,13,127,128,255,...Buffer.from('中文 pipe','utf8')]);
 const result=await throughRunner(runner,args,{...process.env,SIDEX_RTEX_LEGACY_OT1:'1',SIDEX_RUNNER_TEST_EXIT:'7'},bytes);
 assert.equal(result.code,7,result.stderr);assert.deepEqual(result.stdout,bytes);
 const seen=result.stderr.trim().split(/\r?\n/).map(line=>Buffer.from(line.slice(4),'base64').toString('utf8'));
 assert.deepEqual(seen.slice(0,-1),args.slice(0,-1));assert(seen.at(-1).startsWith(String.raw`\ifdefined\pdfpagewidth`));assert(seen.at(-1).includes(String.raw`\def\encodingdefault{OT1}\fontencoding{OT1}\selectfont`));assert(seen.at(-1).endsWith(args.at(-1)));
 const version=await throughRunner(runner,['--version'],{...process.env});assert.equal(version.code,0);assert.equal(Buffer.from(version.stderr.trim().slice(4),'base64').toString('utf8'),'--version');
 const fileResult=await throughRunner(runner,['-interaction=batchmode','paper 中文 with spaces.tex'],{...process.env,SIDEX_RTEX_LEGACY_OT1:'1'});
 const fileArgs=fileResult.stderr.trim().split(/\r?\n/).map(line=>Buffer.from(line.slice(4),'base64').toString('utf8'));
 assert.equal(fileArgs[1],'--jobname=paper 中文 with spaces');assert.equal(fileArgs.length,3);
 const explicit=await throughRunner(runner,['-jobname=custom','paper.tex'],{...process.env,SIDEX_RTEX_LEGACY_OT1:'1'});
 const explicitArgs=explicit.stderr.trim().split(/\r?\n/).map(line=>Buffer.from(line.slice(4),'base64').toString('utf8'));
 assert.equal(explicitArgs.length,2);assert.equal(explicitArgs[0],'-jobname=custom');

 await fs.writeFile(path.join(bins[0],'lualatex.path'),'damaged');
 await assert.rejects(prepareRtexLatexRunner(executable,cache,{compiler}),/Incomplete or corrupted/);
});

test('killing the Windows runner closes only its owned engine and descendants',{skip:process.platform!=='win32',timeout:20000},async t=>{
 const {root,executable,compiler,cache}=await fakeLatex(t),bin=await prepareRtexLatexRunner(executable,cache,{compiler});
 const pidfile=path.join(root,'owned-pids.txt'),runner=spawn(path.join(bin,'lualatex.exe'),['--version'],{windowsHide:true,env:{...process.env,SIDEX_RUNNER_TEST_PIDFILE:pidfile},stdio:'pipe'});
 let ids=[];const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 try{
  const deadline=Date.now()+5000;while(Date.now()<deadline){try{ids=(await fs.readFile(pidfile,'utf8')).trim().split(' ').map(Number);if(ids.length===2)break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(ids.length,2,'engine did not report its owned processes');assert(ids.every(alive));
  runner.kill('SIGKILL');const deadline2=Date.now()+3000;while(Date.now()<deadline2&&ids.some(alive))await new Promise(resolve=>setTimeout(resolve,10));
  assert(ids.every(pid=>!alive(pid)),'runner left a native engine or descendant running');
 }finally{if(!runner.killed)runner.kill('SIGKILL');for(const pid of ids)if(alive(pid))process.kill(pid,'SIGKILL');}
});


test('native runner preserves special source names, jobname and explicit font encodings',{
 skip:process.env.SIDEX_RTEX_NATIVE_TEST!=='1'||process.platform!=='win32',timeout:30000,
},async t=>{
 const {detectTexRuntime,withTexPath}=await import('./runtime-paths.mjs');
 const runtime=detectTexRuntime({root:checkout}),root=await fs.mkdtemp(path.join(os.tmpdir(),'sidex-runner-native-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const env=withTexPath({...process.env,SIDEX_RTEX_LEGACY_OT1:'1'},runtime);
 for(const[key,name]of [['TEXMFVAR','texmf-var'],['TEXMFCONFIG','texmf-config'],['TEXMFHOME','texmf-home']])env[key]=path.join(runtime.texmfRoot,name);
 const bin=await prepareRtexLatexRunner(runtime.commands.lualatex,path.join(root,'cache 中文 with spaces'),{env});
 const name='paper 空格 % & {test}',source=String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{times}
\setlength{\pdfpagewidth}{8.5in}
\setlength{\pdfpageheight}{11in}
\ifx\pdfpagewidth\pagewidth\else\errmessage{not a dimension alias}\fi
\makeatletter\typeout{SIDEX-ENCODING:\encodingdefault}\makeatother
\begin{document}A safe file path.\end{document}`;
 await fs.writeFile(path.join(root,name+'.tex'),source);
 await execute(path.join(bin,'lualatex.exe'),['-interaction=nonstopmode','-halt-on-error',name+'.tex'],{cwd:root,env});
 assert((await fs.stat(path.join(root,name+'.pdf'))).size>1000);
 const log=await fs.readFile(path.join(root,name+'.log'),'utf8');assert(log.includes('SIDEX-ENCODING:T1'));assert(!log.includes('Option clash'));
 assert.equal(await fs.readFile(path.join(root,name+'.tex'),'utf8'),source);
});

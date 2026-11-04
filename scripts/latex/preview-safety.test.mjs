import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:"export {RealtimePreview} from './src/latex/rtex/preview';export {PreviewModel} from './src/latex/rtex/vendor/model';export {SourceBindings} from './src/latex/rtex/source-bindings';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'pdf-task-fixture',setup(build){
 build.onResolve({filter:/^pdfjs-dist$/},()=>({path:'pdf',namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export function getDocument(options){return globalThis.__previewSafetyPdfTask(options);}'}));
}}]});
await fs.mkdir('.runtime/test-bundles',{recursive:true});const file=path.resolve('.runtime/test-bundles/preview-safety-regression.mjs');await fs.writeFile(file,bundle.outputFiles[0].text);
const {RealtimePreview,PreviewModel,SourceBindings}=await import(pathToFileURL(file));
const sp=65536;
const line=(x,y,char=65)=>({x:x*sp,y:y*sp,w:100*sp,h:7*sp,d:2*sp,items:[['g',0,char,null,(x+2)*sp,y*sp,96*sp,0]]});
const dl=lines=>({kind:'page',fonts:{0:{name:'Fixture',size:10*sp}},lines,other:[],flags:{},width:300*sp,height:500*sp,depth:0,page_width:300*sp,page_height:500*sp});
const fragment=(positions,first=1)=>({page:1,first_line:first,last_line:first+positions.length-1,x:positions[0][0]*sp,xs:positions.map(([x])=>x*sp),baselines:positions.map(([,y])=>y*sp),approximate:false});
function layout(revision=1,positions=[[10,20],[10,34]]){
 const paragraph=positions.map(([x,y])=>line(x,y)),neighbor=line(10,80,78),page={page:1,exact:true,hash:revision,dl:dl([...paragraph,neighbor])};
 return {event:'LayoutUpdate',versions:{source_revision:revision,layout_version:revision,engine_generation:1,context_revision:1},compile:{state:'Ok'},pages_total:1,pages_changed:[page],placements:[{par_id:7,kind:'par',lines:positions.length,fragments:[fragment(positions)]},{par_id:8,kind:'par',lines:1,fragments:[fragment([[10,80]],positions.length+1)]}]};
}
function update(revision=2,positions=[[10,20],[10,34]]){
 const display=dl(positions.map(([,y],i)=>line(0,i*14,66)));
 return {type:'engine-event',value:{event:'ParagraphUpdate',par_id:7,status:'ok',versions:{source_revision:revision,layout_version:1,engine_generation:1,context_revision:1},dl:display,fragments:[fragment(positions)],pagination_stale:false,timing:{total_us:500}}};
}
function fixture(positions){
 const initial=layout(1,positions),model=new PreviewModel();model.applyLayout({pages:initial.pages_changed,pagesTotal:1,placements:initial.placements,keepFromRevision:null});
 const bindings=new SourceBindings(),source='A plain paragraph.';bindings.install('main.tex',source,[{id:7,kind:'Body',range:{start:0,end:source.length},last_revision:1,hash:1}],1);
 const statuses=[],notices=[],sent=[],scheduled=[],oldDocument={name:'baseline-pdf',numPages:1,destroy:()=>Promise.resolve()},controller=Object.create(RealtimePreview.prototype);
 Object.assign(controller,{enabled:true,model,bindings,layoutRevision:1,latestRevision:1,layoutTicket:0,session:1,loadingPdf:null,document:oldDocument,preservePdf:false,version:1,loadingPdf:null,
  pending:new Map(),inFlight:null,sequence:0,documentTimer:undefined,layoutRefreshTimer:undefined,lastLayoutRequestRevision:0,layoutPending:false,exportPending:false,blockedOverlays:new Map(),rowCache:new Map(),rowsByUnit:null,layoutPages:new Map(),bases:new Map(),block:null,
  fonts:{get:()=>({kind:'type1'}),glyph:()=>({})},images:{get:()=>undefined},socket:{readyState:1,send:raw=>sent.push(JSON.parse(raw))},
  options:{files:()=>[{name:'main.tex',content:source}],status:(text,kind)=>statuses.push({text,kind}),notify:(message,error)=>notices.push({message,error}),pages(){},token:()=> 'fixture-token',log(){},fallback(){}},
  schedule:pages=>scheduled.push(pages?[...pages]:[...model.pages.keys()])});
 const send=async packet=>{const revision=packet.value?.versions?.source_revision;if(revision)await controller.receive({type:'document-ack',revision,sequence:-1});await controller.receive(packet);};
 const install=async value=>{
  const document={name:'pdf-revision-'+value.versions.source_revision,numPages:value.pages_total,destroy:()=>Promise.resolve()};
  globalThis.__previewSafetyPdfTask=()=>({promise:Promise.resolve(document),destroy:()=>Promise.resolve()});
  await controller.installLayout({value,pdf:{generation:1,layout:value.versions.layout_version}},1);return document;
 };
 return {controller,model,bindings,initial,statuses,notices,sent,scheduled,oldDocument,send,install,cleanup(){clearTimeout(controller.documentTimer);clearTimeout(controller.layoutRefreshTimer);controller.enabled=false;}};
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,timeout=1200){const started=Date.now();while(Date.now()-started<timeout){if(test())return;await pause(5);}assert.fail('Timed out waiting for layout debounce');}

test('a late ParagraphUpdate at the installed full-PDF revision is ignored instead of covering the new page again',async()=>{
 const f=fixture();try{
  const complete=layout(2),pdf=await f.install(complete),beforeSchedules=f.scheduled.length;
  await f.send(update(2));assert.equal(f.model.overlays.size,0);assert.equal(f.controller.blockedOverlays.size,0);assert.equal(f.scheduled.length,beforeSchedules);assert.equal(f.controller.document,pdf);assert.equal(f.model.pages.get(1),complete.pages_changed[0]);assert(f.statuses.at(-1).text.includes('已同步'));assert.equal(f.notices.length,0);
 }finally{f.cleanup();}
});

test('production safeOverlay and receive accept same-slot prose despite shared image metadata',async()=>{
 const f=fixture();try{
  const packet=update(2);packet.value.dl.images_info={5:{file:'a-picture-on-another-page.pdf'}};
  const candidate={parId:7,revision:2,dl:packet.value.dl,fragments:packet.value.fragments};assert(f.controller.safeOverlay(candidate).safe);
  await f.send(packet);assert.equal(f.model.overlays.get(7).revision,2);assert.equal(f.controller.blockedOverlays.size,0);assert.equal(f.controller.document,f.oldDocument);
  const page=f.controller.pageRows(1);assert.equal(page.overlays.length,1);assert.equal(page.rows.filter(row=>row.parId===7).length,2);assert.equal(page.rows.filter(row=>row.parId===8).length,1);assert.equal(f.statuses.at(-1).kind,'live');
 }finally{f.cleanup();}
});

test('an actual transformed PDF-image placeholder never reaches the overlay painter or replaces baseline rows',async()=>{
 const f=fixture();try{
  const packet=update(2);packet.value.dl.lines[0].items=[['M','save',0,0,''],['M','set',0,0,'.5 0 0 .5'],['r',0,0,200*sp,80*sp],['M','restore',0,0,'']];
  const before=f.model.pages.get(1),rows=f.controller.pageRows(1).rows;await f.send(packet);
  assert.equal(f.model.overlays.size,0);assert.equal(f.controller.blockedOverlays.get(7),2);assert.equal(f.model.pages.get(1),before);assert.equal(f.controller.document,f.oldDocument);
  const after=f.controller.pageRows(1);assert.equal(after.overlays.length,0);assert.deepEqual(after.rows.map(row=>row.line),rows.map(row=>row.line));assert(f.statuses.at(-1).text.includes('真实 PDF'));
 }finally{f.cleanup();}
});

test('a burst of unsafe growing-paragraph updates coalesces to one full-layout request after input settles',async()=>{
 const f=fixture();try{
  for(let revision=2;revision<=18;revision++)await f.send(update(revision,[[10,20],[10,34],[10,48]]));
  assert.equal(f.sent.length,0);assert.equal(f.model.overlays.size,0);assert.equal(f.controller.blockedOverlays.get(7),18);
  await until(()=>f.sent.length===1);assert.deepEqual(f.sent,[{type:'layout'}]);assert.equal(f.controller.lastLayoutRequestRevision,18);
  await f.send(update(18,[[10,20],[10,34],[10,48]]));await pause(180);assert.equal(f.sent.length,1);
 }finally{f.cleanup();}
});

test('safe continued typing clears a blocked paragraph and cancels the stale full-layout demand',async()=>{
 const f=fixture();try{
  await f.send(update(2,[[10,20],[10,34],[10,48]]));assert.equal(f.controller.blockedOverlays.get(7),2);
  await f.send(update(3));assert.equal(f.controller.blockedOverlays.size,0);assert.equal(f.model.overlays.get(7).revision,3);assert.equal(f.statuses.at(-1).kind,'live');
  await pause(180);assert.equal(f.sent.length,0);assert.equal(f.controller.pageRows(1).overlays.length,1);
 }finally{f.cleanup();}
});

test('retained newer overlays are revalidated against a newly installed shorter slot, not painted over its neighbors',async()=>{
 const f=fixture();try{
  await f.send(update(3));assert.equal(f.model.overlays.size,1);
  const page=layout(2,[[10,20]]),pdf=await f.install(page);
  assert.equal(f.controller.document,pdf);assert.equal(f.controller.layoutRevision,2);assert.equal(f.model.overlays.size,0);assert.equal(f.controller.blockedOverlays.get(7),3);
  assert.equal(f.controller.pageRows(1).overlays.length,0);assert(f.statuses.at(-1).text.includes('更新分页'));await until(()=>f.sent.length===1);assert.deepEqual(f.sent,[{type:'layout'}]);assert.equal(f.notices.length,0);
 }finally{f.cleanup();}
});

test('a retained overlay that still fits a moved column stays local after installing the older complete layout',async()=>{
 const f=fixture();try{
  await f.send(update(3));await f.install(layout(2,[[150,20],[150,34]]));
  assert.equal(f.model.overlays.get(7)?.revision,3);assert(f.controller.safeOverlay(f.model.overlays.get(7)).safe);assert.equal(f.controller.blockedOverlays.size,0);
  const rows=f.controller.pageRows(1).overlays[0].rows;assert.equal(rows[0].line.x+rows[0].dx,150*sp);assert.equal(f.notices.length,0);
 }finally{f.cleanup();}
});

test('an older safe paragraph reply cannot clear a newer blocked revision or paint stale text',async()=>{
 const f=fixture();try{
  await f.send(update(5,[[10,20],[10,34],[10,48]]));assert.equal(f.controller.blockedOverlays.get(7),5);const statuses=f.statuses.length;
  await f.send(update(4));assert.equal(f.controller.blockedOverlays.get(7),5);assert.equal(f.model.overlays.size,0);assert.equal(f.statuses.length,statuses);assert.equal(f.controller.latestRevision,5);
 }finally{f.cleanup();}
});

test('an older complete layout cannot roll the installed PDF or cached page list backward',async()=>{
 const f=fixture();try{
  const current=layout(4,[[150,20],[150,34]]),pdf=await f.install(current);f.controller.layoutPages.set(1,current.pages_changed[0]);const ticket=f.controller.layoutTicket;
  await f.controller.receive({type:'engine-event',value:layout(3)});await Promise.resolve();
  assert.equal(f.controller.layoutRevision,4);assert.equal(f.controller.document,pdf);assert.equal(f.model.pages.get(1),current.pages_changed[0]);assert.equal(f.controller.layoutPages.get(1),current.pages_changed[0]);assert.equal(f.controller.layoutTicket,ticket);assert.equal(f.notices.length,0);
 }finally{f.cleanup();}
});


test('a late source binding refreshes only the live paragraph page, not unrelated pages',async()=>{
 const f=fixture();try{
  f.controller.spans=new Map([['main.tex',[]]]);f.model.pages.set(2,{...f.initial.pages_changed[0],page:2});f.model.pagesTotal=2;
  await f.send(update(2));const before=f.scheduled.length,source='A changed paragraph.';
  await f.controller.receive({type:'spans',file:'main.tex',source,revision:2,spans:[{id:7,kind:'Body',range:{start:0,end:source.length},last_revision:2,hash:2}]});
  assert.equal(f.scheduled.length,before+1);assert.deepEqual(f.scheduled.at(-1),[1]);assert.equal(f.controller.bindings.resolve(7,2).source,source);
 }finally{f.cleanup();}
});

test('a new file snapshot with unchanged visible paragraph text causes no raster work',async()=>{
 const f=fixture();try{
  f.controller.spans=new Map([['main.tex',[]]]);await f.send(update(2));const before=f.scheduled.length,source='A plain paragraph.\nOther changed text.';
  await f.controller.receive({type:'spans',file:'main.tex',source,revision:2,spans:[{id:7,kind:'Body',range:{start:0,end:18},last_revision:1,hash:1}]});
  assert.equal(f.scheduled.length,before);assert.equal(f.controller.bindings.resolve(7,2).source,source);
 }finally{f.cleanup();}
});

test('first source bindings still invalidate unbound hit groups across the initial layout',async()=>{
 const f=fixture();try{
  f.controller.spans=new Map();f.controller.hitLayers=new Map([[1,{groups:new Map([[0,{}]])}]]);f.controller.orphanCacheRevision=1;
  const source='A plain paragraph.';await f.controller.receive({type:'spans',file:'main.tex',source,revision:1,spans:[{id:7,kind:'Body',range:{start:0,end:source.length},last_revision:1,hash:1}]});
  assert.equal(f.controller.hitLayers.get(1).groups.has(0),false);assert.equal(f.controller.orphanCacheRevision,-1);assert.deepEqual(f.scheduled.at(-1),[1]);
 }finally{f.cleanup();}
});

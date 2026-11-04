// Replays the actual frontend session controller against rtex, with pagination
// deliberately held at its first revision. No browser, paper files or user service are changed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {WebSocket} from 'ws';
import {build} from 'esbuild';
import {createBridge} from './bridge.mjs';
const root=path.resolve(process.env.SIDEX_TEST_PROJECT||'examples/latex-live-edit');
const expectLayoutFallback=process.env.SIDEX_EXPECT_LAYOUT_FALLBACK==='1';
const previewOverride=process.env.SIDEX_TEST_PREVIEW_SOURCE;
const bundled=await build({stdin:{contents:"export {RealtimePreview} from './src/latex/rtex/preview';export {PreviewModel} from './src/latex/rtex/vendor/model';export {FontStore} from './src/latex/rtex/vendor/render';export {SourceBindings,rebaseTarget} from './src/latex/rtex/source-bindings';export {paragraphRegions} from './src/latex/rtex/paragraph-regions';export {paragraphTarget} from './src/latex/rtex/block-edit';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'preview-before-after',setup(b){if(previewOverride)b.onLoad({filter:/[\\/]rtex[\\/]preview\.ts$/},async args=>({contents:await fs.readFile(previewOverride,'utf8'),loader:'ts',resolveDir:path.dirname(args.path)}));}},{name:'no-browser-pdf',setup(b){b.onResolve({filter:/^pdfjs-dist$/},()=>({path:'pdf',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export function getDocument(){throw Error("Background PDF loading must stay outside the fast event chain");}'}));}}]});
await fs.mkdir('.runtime/live-session',{recursive:true});await fs.rm('.runtime/live-session/result.json',{force:true});const bundle='.runtime/live-session/frontend-core.mjs';await fs.writeFile(bundle,bundled.outputFiles[0].text);
const {RealtimePreview,PreviewModel,FontStore,SourceBindings,rebaseTarget,paragraphRegions,paragraphTarget}=await import(pathToFileURL(path.resolve(bundle)));

// The production page-input controller runs against real rtex glyphs. This DOM
// stand-in verifies focus/source semantics, not browser painting or frame latency.
class PageNode {
 constructor(){this.children=[];this.style={width:'612px',getPropertyValue:()=> '1'};this.clientWidth=612;this.classList={toggle(){}};this.value='';this.selectionStart=this.selectionEnd=0;}
 append(node){this.children.push(node);node.parentElement=this;} replaceChildren(){this.children=[];}
 setAttribute(){} addEventListener(){} removeEventListener(){}
 focus(){document.activeElement=this;} setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
 setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.setSelectionRange(start+text.length,start+text.length);}
 getBoundingClientRect(){return {left:0,top:0,width:612,height:792};} remove(){}
}
globalThis.Path2D=class{moveTo(){}lineTo(){}bezierCurveTo(){}quadraticCurveTo(){}closePath(){}};
const bridge=createBridge(),server=createServer((req,res)=>bridge.middleware(req,res,()=>res.end()));server.on('upgrade',bridge.upgrade);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,session=await(await fetch(origin+'/__latex/session')).json(),headers={'Content-Type':'application/json','X-LaTeX-Token':session.token};
const api=async(name,data={})=>{const r=await fetch(origin+'/__latex/'+name,{method:'POST',headers,body:JSON.stringify(data)}),value=await r.json();if(!r.ok)throw Error(value.error);return value;};
const project=await api('open',{path:root}),documents=new Map(project.files.map(f=>[f.name,f.content])),main=project.files.find(f=>f.name==='main.tex').name;
let startupDocuments=project.files;
if(process.env.SIDEX_TEST_DRAFTS){const backup=JSON.parse(await fs.readFile(process.env.SIDEX_TEST_DRAFTS,'utf8')),drafts=new Map(backup.packets.map(packet=>[packet.file,packet.source]));startupDocuments=project.files.map(file=>drafts.has(file.name)?{...file,content:drafts.get(file.name)}:file);for(const file of startupDocuments)documents.set(file.name,file.content);}
const ws=new WebSocket(origin.replace('http:','ws:')+'/__latex/realtime?token='+session.token,{origin}),events=[],statuses=[],sent=[];let failure,controller=null,chain=Promise.resolve();
ws.on('message',raw=>{const packet=JSON.parse(raw.toString());events.push(packet);if(packet.type==='error')failure=Error(packet.message);if(controller)chain=chain.then(()=>controller.receive(packet)).catch(error=>{failure=error;});});
const send=x=>ws.send(JSON.stringify(x));
const wait=async(test,timeout=45000)=>{const start=Date.now();while(Date.now()-start<timeout){if(failure)throw failure;if(test())return;await new Promise(r=>setTimeout(r,2));}throw Error('Timed out: '+statuses.slice(-3));};
try{
 await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});send({type:'start',main,documents:startupDocuments});
 await wait(()=>events.some(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.pdf)&&events.some(e=>e.type==='spans'&&e.file===project.files.filter(f=>f.name.endsWith('.tex')).at(-1).name));
 const initial=events.find(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.pdf),pdfUrl=origin+`/__latex/realtime-pdf?generation=${initial.pdf.generation}&layout=${initial.pdf.layout}`;
 assert.equal(typeof initial.pdf,'object');assert.equal((await fetch(pdfUrl)).status,403);assert.equal((await fetch(pdfUrl,{headers:{...headers,Origin:'https://untrusted.test'}})).status,403);
 const pdf=await fetch(pdfUrl,{headers});assert.equal(pdf.status,200);assert(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
 const model=new PreviewModel();model.applyLayout({pages:initial.value.pages_changed,pagesTotal:initial.value.pages_total,placements:initial.value.placements,keepFromRevision:null});
 const bindings=new SourceBindings(),fonts=new FontStore();
 for(const packet of events){if(packet.type==='spans')bindings.install(packet.file,packet.source,packet.spans,packet.revision);if(packet.type==='resources')for(const[key,font]of packet.fonts)fonts.add(key,font.data?{...font,data:new Uint8Array(Buffer.from(font.data,'base64'))}:font);}
 const preview=Object.create(RealtimePreview.prototype);
 Object.assign(preview,{enabled:true,model,bindings,fonts,images:{get:()=>undefined},rowCache:new Map(),rowsByUnit:null,layoutRevision:initial.value.versions.source_revision,pageCount:model.pagesTotal,
  hitLayers:new Map(),blockedOverlays:new Map(),lastLayoutRequestRevision:0,layoutRefreshTimer:undefined,pending:new Map(),inFlight:null,sequence:0,latestRevision:1,exportPending:false,documentTimer:undefined,spanSources:new Map(),spans:new Map(),session:1,
  socket:{readyState:1,send:raw=>{const packet=JSON.parse(raw);sent.push({...packet,at:performance.now()});ws.send(raw);}},
  options:{files:()=>[...documents].map(([name,content])=>({name,content})),notify:message=>{throw Error(message);},log:()=>{}},
  status:(text,kind)=>statuses.push({text,kind}),schedule:()=>{},installLayout:async()=>{},layoutPages:new Map()});
 const candidates=[];
 for(let page=1;page<=model.pagesTotal;page++)for(const row of preview.pageRows(page).rows){if(candidates.some(c=>c.id===row.parId))continue;const unit=preview.unit(row);if(!unit)continue;const region=paragraphRegions(unit.rows,unit.source).find(r=>r.target.kind==='paragraph'&&r.target.text.length>150);if(region)candidates.push({id:row.parId,row,unit,target:{...region.target,file:unit.file,from:unit.from+region.target.from,to:unit.from+region.target.to}});}
 const a=(process.env.SIDEX_TEST_CANDIDATE_FILE&&candidates.find(c=>c.unit.file===process.env.SIDEX_TEST_CANDIDATE_FILE))||candidates[0],b=candidates.find(c=>c.unit.file!==a.unit.file)||candidates.find(c=>c.id!==a.id);assert(a&&b);
 const safetyLog=[],checkSafety=preview.safeOverlay.bind(preview);preview.safeOverlay=(...args)=>{const result=checkSafety(...args);safetyLog.push({id:args[0].parId,lines:args[0].dl.lines.length,revision:args[0].revision,...result});return result;};
 controller=preview;
 const pages=new Map([...model.pages.keys()].map(page=>[page,new PageNode()])),body=new PageNode();
 globalThis.document={activeElement:null,body,createElement:()=>new PageNode(),addEventListener(){},removeEventListener(){}};
 globalThis.window={addEventListener(){},removeEventListener(){}};
 const analysisBundle=await build({stdin:{contents:"export {analyzeUnit} from './src/latex/rtex/analyze-unit';export {resizeGraphic,resizeGraphicAxes,imageRectangles} from './src/latex/rtex/object-edit';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
 const {analyzeUnit,resizeGraphic,resizeGraphicAxes,imageRectangles}=await import('data:text/javascript;base64,'+Buffer.from(analysisBundle.outputFiles[0].text).toString('base64'));
 const objectKeys={image:new Set(),table:new Set()},seenUnits=new Set();
 for(const page of model.pages.keys())for(const row of preview.pageRows(page).rows){if(row.parId===undefined||seenUnits.has(row.parId))continue;seenUnits.add(row.parId);const unit=preview.unit(row);if(!unit)continue;for(const object of analyzeUnit(unit.rows,unit.source).objects)objectKeys[object.kind].add(unit.file+':'+(unit.from+object.target.from));}
 Object.assign(preview,{sourceCursorTicket:0,targetSources:new WeakMap(),geometryUnits:new Map([[a.id,{unit:a.unit,analysis:analyzeUnit(a.unit.rows,a.unit.source)}]])});
 Object.assign(preview.options,{container:{querySelectorAll:()=>[],querySelector:selector=>pages.get(Number(/data-page="(\d+)"/.exec(selector)?.[1]))},editBoundary:()=>{},
  edit:(file,from,to,expected,replacement)=>{const before=documents.get(file);assert.equal(before.slice(from,to),expected);const after=before.slice(0,from)+replacement+before.slice(to);documents.set(file,after);preview.documentChanged(file,after);return true;}});
 await preview.focusSource(a.unit.file,a.target.from+10,false);assert([...pages.values()].some(page=>page.children.some(node=>node.className==='rtex-source-caret')));
 const orphanImages=preview.orphanObjects().length;
 let teaserResizeAndRestore=false;
 if(process.env.SIDEX_TEST_OBJECTS==='1'){
  const orphan=preview.orphanObjects()[0];assert(orphan,'Expected the unique title teaser mapping');
  const file=orphan.target.file,originalText=documents.get(file),next=originalText.slice(0,orphan.target.from)+resizeGraphicAxes(orphan.target.text,{x:.95,y:1.05},{widthBp:orphan.region.w/65781.76,heightBp:orphan.region.h/65781.76})+originalText.slice(orphan.target.to);
  const layoutCount=events.filter(e=>e.value?.event==='LayoutUpdate').length;
  documents.set(file,next);preview.documentChanged(file,next);preview.requestLayout();
  await wait(()=>preview.inFlight===null&&preview.pending.size===0&&events.filter(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.value.versions.source_revision>=preview.latestRevision).length&&events.filter(e=>e.value?.event==='LayoutUpdate').length>layoutCount);await chain;
  const resizedLayout=events.filter(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok').at(-1),page=resizedLayout.value.pages_changed.find(p=>p.page===orphan.region.page);assert(page);
  const resizedBox=imageRectangles(page.dl.lines.map(line=>({page:page.page,dl:page.dl,line,dx:0,dy:0})))[0];assert(resizedBox);assert(Math.abs(resizedBox.w/orphan.region.w-.95)<.005);assert(Math.abs(resizedBox.h/orphan.region.h-1.05)<.005);
  const count=events.filter(e=>e.value?.event==='LayoutUpdate').length;
  documents.set(file,originalText);preview.documentChanged(file,originalText);preview.requestLayout();
  await wait(()=>preview.inFlight===null&&preview.pending.size===0&&events.filter(e=>e.value?.event==='LayoutUpdate').length>count&&events.filter(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok').at(-1)?.value.versions.source_revision>=preview.latestRevision);await chain;
  teaserResizeAndRestore=true;
 }

 preview.openDirect(a.target,a.id);assert(preview.direct);const input=preview.direct.input;assert.equal(document.activeElement,input);assert(preview.direct.geometry.length);
 const beforeDirect=documents.get(a.unit.file),fromDirect=10,toDirect=Math.min(70,input.value.length),fastBefore=events.filter(e=>e.value?.event==='ParagraphUpdate').length;
 input.setSelectionRange(fromDirect,toDirect);input.onbeforeinput({inputType:'deleteContentForward',preventDefault(){}});input.setRangeText('',fromDirect,toDirect);
 const sentBeforeInput=sent.length,inputStarted=performance.now();input.oninput();const directInputHandlerMs=performance.now()-inputStarted;
 const afterDirect=documents.get(a.unit.file);assert.notEqual(afterDirect,beforeDirect);
 await wait(()=>preview.inFlight===null&&preview.pending.size===0&&events.some(e=>e.type==='spans'&&e.source===afterDirect)&&events.filter(e=>e.value?.event==='ParagraphUpdate').length>fastBefore);await chain;
 assert(events.filter(e=>e.value?.event==='ParagraphUpdate').length>fastBefore);assert.equal(document.activeElement,input);
 input.onkeydown({key:'z',ctrlKey:true,preventDefault(){}});assert.equal(documents.get(a.unit.file),beforeDirect);
 await wait(()=>preview.inFlight===null&&preview.pending.size===0&&events.some(e=>e.type==='spans'&&e.source===beforeDirect&&e.revision>1));await chain;
 preview.closeEditor();
 let text=documents.get(a.unit.file),latest=text,from=a.target.from,to=a.target.to;const started=performance.now();
 for(let i=0;i<24;i++){
  const replacement=a.target.text+' '+('live '.repeat(i+1));latest=text.slice(0,from)+replacement+text.slice(to);documents.set(a.unit.file,latest);preview.documentChanged(a.unit.file,latest);
  await new Promise(r=>setTimeout(r,1));
 }
 await wait(()=>preview.inFlight===null&&preview.pending.size===0&&events.some(e=>e.type==='spans'&&e.file===a.unit.file&&e.source===latest));await chain;
 assert(sent.filter(e=>e.type==='document').length<24,'Burst typing should send only coalesced changes');
 assert(preview.unit(b.row),'Other units must remain editable on the frozen old PDF');
 assert(rebaseTarget(b.target,b.unit.document,documents.get(b.unit.file)),'The old hit box must resolve to current source');
 const fastEvents=events.filter(e=>e.value?.event==='ParagraphUpdate'&&['ok','ok_degraded'].includes(e.value.status));assert(fastEvents.length);
 const exactGlyphOverlayAccepted=statuses.some(s=>s.kind==='live');
 let unsafeGeometryDeferred=false;
 if(expectLayoutFallback){
  assert(safetyLog.some(s=>!s.safe),'The real two-column fixture must exercise unsafe fast geometry');
  assert.equal(model.overlays.size,0,'Unsafe fast rows must never cover the original PDF');
  await wait(()=>sent.some(packet=>packet.type==='layout'));await chain;
  await wait(()=>events.some(e=>e.value?.event==='LayoutUpdate'&&e.value.compile?.state==='Ok'&&e.value.versions.source_revision>=preview.latestRevision&&e.pdf));await chain;
  assert(preview.unit(a.row),'Editing on the old PDF must remain available while complete layout is held');
  unsafeGeometryDeferred=true;
 }else assert(exactGlyphOverlayAccepted,'Frontend must accept exact glyph overlays, rather than waiting for a full PDF');
 // Keep a deliberately unfinished formula in A while immediately editing B.
 const broken=latest.slice(0,from)+'\\frac{'+latest.slice(from);documents.set(a.unit.file,broken);preview.documentChanged(a.unit.file,broken);
 await wait(()=>preview.inFlight===null&&preview.pending.size===0);await chain;assert(preview.unit(b.row));
 const bCurrent=documents.get(b.unit.file),currentTarget=rebaseTarget(b.target,b.unit.document,bCurrent);assert(currentTarget);
 const bEdit=bCurrent.slice(0,currentTarget.from)+currentTarget.text+' Extra live text.'+bCurrent.slice(currentTarget.to);documents.set(b.unit.file,bEdit);preview.documentChanged(b.unit.file,bEdit);
 await wait(()=>preview.inFlight===null&&preview.pending.size===0&&events.some(e=>e.type==='spans'&&e.file===b.unit.file&&e.source===bEdit));await chain;assert(preview.unit(b.row));
 for(const file of project.files)assert.equal(await fs.readFile(path.join(root,file.name),'utf8'),file.content);
 const result={pages:model.pagesTotal,inputEdits:24,sentDocuments:sent.filter(e=>e.type==='document').length,fastUpdates:fastEvents.length,engineMs:fastEvents.map(e=>Number((e.value.timing.total_us/1000).toFixed(2))),directInputHandlerMs:Number(directInputHandlerMs.toFixed(2)),firstInputToDispatchMs:Number((sent.slice(sentBeforeInput).find(packet=>packet.type==='document').at-inputStarted).toFixed(2)),directPageInputAndUndo:true,characterSyncUsesGlyphGeometry:true,teaserResizeAndRestore,pageObjects:{images:objectKeys.image.size+orphanImages,tables:objectKeys.table.size},roundTripBurstMs:Math.round(performance.now()-started),oldPageStillEditable:true,otherFileEditableWithIncompleteSyntax:true,binaryPdfTransport:true,exactGlyphOverlayAccepted,unsafeGeometryDeferred,unsafeReasons:[...new Set(safetyLog.filter(s=>!s.safe).map(s=>s.reason))],sourceFilesUnchanged:true};
 await fs.writeFile('.runtime/live-session/safety.json',JSON.stringify(safetyLog));await fs.writeFile('.runtime/live-session/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{controller=null;if(ws.readyState===1)send({type:'stop'});ws.close();await bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));}

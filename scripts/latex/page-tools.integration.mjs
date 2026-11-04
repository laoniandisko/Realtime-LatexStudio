// Real rtex checks for source reordering, imported-PDF figure resizing and table
// spacing. All source edits stay in memory in an isolated synthetic project.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {WebSocket} from 'ws';
import {build} from 'esbuild';
import {createBridge} from './bridge.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const bundle=await build({stdin:{contents:"export * from './src/latex/rtex/object-edit';export {moveParagraph} from './src/latex/rtex/paragraph-move';export {moveObject} from './src/latex/rtex/object-move';export {paragraphTarget} from './src/latex/rtex/block-edit';export {glyphTextOf} from './src/latex/rtex/vendor/glyphMap';export {analyzeUnit} from './src/latex/rtex/analyze-unit';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {graphics,resizeGraphic,resizeGraphicAxes,resizeTable,tableSetting,moveParagraph,moveObject,paragraphTarget,glyphTextOf,imageRectangles,analyzeUnit}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const root=path.resolve('.runtime/page-tools/paper');await fs.mkdir(root,{recursive:true});
const stream='0.2 0.4 0.8 rg 0 0 200 80 re f\n',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 80] /Resources << >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await fs.writeFile(path.join(root,'figure.pdf'),pdf);
const original=String.raw`\documentclass{article}
\usepackage{graphicx,booktabs}
\begin{document}
\section{Page tools}

FirstAnchor starts the first paragraph with \emph{preserved emphasis} and a reference to Figure~\ref{fig:keep}.

SecondAnchor starts the second paragraph. This paragraph stays separate from its neighbours.

ThirdAnchor starts the final paragraph, with an inline expression $x^2+y^2$ that stays untouched.

\begin{figure}[ht]
\centering
\includegraphics[width=0.45\linewidth]{figure.pdf}
\caption{Preserved figure caption.}\label{fig:keep}
\end{figure}

\begin{table}[ht]
\centering
\begin{tabular}{ll}
\toprule
CellAlpha & CellBeta \\
RowAlpha & RowBeta \\
\bottomrule
\end{tabular}
\caption{Preserved table caption.}\label{tab:keep}
\end{table}
\end{document}
`;
await fs.writeFile(path.join(root,'main.tex'),original);
const bridge=createBridge(),server=createServer((req,res)=>bridge.middleware(req,res,()=>res.end()));server.on('upgrade',bridge.upgrade);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,session=await(await fetch(origin+'/__latex/session')).json(),headers={'Content-Type':'application/json','X-LaTeX-Token':session.token};
const project=await(await fetch(origin+'/__latex/open',{method:'POST',headers,body:JSON.stringify({path:root})})).json();assert(project.files);
const ws=new WebSocket(origin.replace('http:','ws:')+'/__latex/realtime?token='+session.token,{origin}),events=[],pages=new Map();let failure,latest,sequence=0;
ws.on('message',raw=>{const packet=JSON.parse(raw.toString());events.push(packet);if(packet.type==='error')failure=Error(packet.message);if(packet.value?.event==='LayoutUpdate'&&packet.value.compile?.state==='Ok'){for(const page of packet.value.pages_changed)pages.set(page.page,page);for(const key of pages.keys())if(key>packet.value.pages_total)pages.delete(key);latest=packet;}});
const wait=async(test,timeout=45000)=>{const started=Date.now();while(Date.now()-started<timeout){if(failure)throw failure;if(test())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for typeset layout');};
const rows=()=>[...pages.values()].flatMap(p=>p.dl.lines.map(line=>({page:p.page,dl:p.dl,line,dx:0,dy:0})));
function locate(text){const r=rows(),gt=glyphTextOf(r),at=gt.text.indexOf(text);assert(at>=0,'Missing rendered anchor '+text);const g=gt.glyphs.find(g=>g.start<=at&&g.start+g.text.length>at);return {page:r[g.row].page,x:g.x,y:g.y};}
async function update(source){const id=++sequence;const started=performance.now();ws.send(JSON.stringify({type:'document',file:'main.tex',text:source,sequence:id}));await wait(()=>events.some(e=>e.type==='document-ack'&&e.sequence===id));const revision=events.find(e=>e.type==='document-ack'&&e.sequence===id).revision;ws.send(JSON.stringify({type:'layout'}));await wait(()=>latest?.value.versions.source_revision>=revision);return performance.now()-started;}
async function pdfSnapshot(name){
 assert(latest.pdf);const data=await(await fetch(origin+`/__latex/realtime-pdf?generation=${latest.pdf.generation}&layout=${latest.pdf.layout}`,{headers})).arrayBuffer();
 const file=path.resolve('.runtime/page-tools/'+name+'.pdf');await fs.writeFile(file,Buffer.from(data));
 const {stdout}=await promisify(execFile)('python',['-X','utf8','-c',`import fitz,json,sys
d=fitz.open(sys.argv[1]);out={'words':{},'captions':[]}
for p in d:
 for w in p.get_text('words'):
  if w[4] in ['CellAlpha','CellBeta','RowAlpha','FirstAnchor','SecondAnchor','ThirdAnchor']:out['words'][w[4]]=list(w[:4])
 for b in p.get_text('dict')['blocks']:
  for l in b.get('lines',[]):
   text=''.join(s['text'] for s in l['spans'])
   if 'Preserved table caption.' in text:out['captions'].append({'text':text,'bbox':l['bbox']})
print(json.dumps(out))`,file]);return JSON.parse(stdout);
}
try{
 await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({type:'start',main:'main.tex',documents:project.files}));await wait(()=>latest);
 const initial=analyzeUnit(rows(),original);assert(initial.objects.some(o=>o.kind==='image'));assert(initial.objects.some(o=>o.kind==='table'));
 const imageBefore=imageRectangles(rows())[0],graphic=graphics(original)[0],resized=resizeGraphic(graphic.text,1.25,imageBefore.w/65781.76);
 let source=original.slice(0,graphic.from)+resized+original.slice(graphic.to);const imageMs=await update(source),imageAfter=imageRectangles(rows())[0];assert(Math.abs(imageAfter.w/imageBefore.w-1.25)<.005);
 const cellBefore=locate('CellAlpha'),secondBefore=locate('CellBeta'),rowBefore=locate('RowAlpha');
 const table=paragraphTarget(source,source.indexOf('\\begin{tabular}')),newTable=tableSetting(tableSetting(table.text,'columns',11),'rows',1.4);
 source=source.slice(0,table.from)+newTable+source.slice(table.to);const tableMs=await update(source);
 const cellAfter=locate('CellAlpha'),secondAfter=locate('CellBeta'),rowAfter=locate('RowAlpha');
 assert(secondAfter.x-cellAfter.x>secondBefore.x-cellBefore.x+8*65781.76);assert(rowAfter.y-cellAfter.y>rowBefore.y-cellBefore.y+2*65781.76);
 const a={...paragraphTarget(source,source.indexOf('FirstAnchor')),file:'main.tex'},b={...paragraphTarget(source,source.indexOf('ThirdAnchor')),file:'main.tex'};
 const moved=moveParagraph([{name:'main.tex',content:source}],a,b,true)[0];source=moved.after;const moveMs=await update(source);
 const first=locate('FirstAnchor'),third=locate('ThirdAnchor');assert(first.page>third.page||(first.page===third.page&&first.y>third.y));
 // Independent image axes must change the real imported-PDF box, not just a CSS outline.
 const beforeAxes=imageRectangles(rows())[0],command=graphics(source)[0],axesSource=resizeGraphicAxes(command.text,{x:1.15,y:1.35},{widthBp:beforeAxes.w/65781.76,heightBp:beforeAxes.h/65781.76});
 source=source.slice(0,command.from)+axesSource+source.slice(command.to);const axesMs=await update(source),afterAxes=imageRectangles(rows())[0];
 assert(Math.abs(afterAxes.w/beforeAxes.w-1.15)<.005);assert(Math.abs(afterAxes.h/beforeAxes.h-1.35)<.005);
 const pdfBefore=await pdfSnapshot('before-table-resize'),currentTable=paragraphTarget(source,source.indexOf('\\begin{tabular}')),tableBox=analyzeUnit(rows(),source).objects.find(o=>o.kind==='table');assert(tableBox);
 const scaled=resizeTable(currentTable.text,{x:.85,y:1.2},{widthBp:tableBox.w/65781.76,heightBp:tableBox.h/65781.76});
 source=source.slice(0,currentTable.from)+scaled.text+source.slice(currentTable.to);const freeTableMs=await update(source),pdfAfter=await pdfSnapshot('after-table-resize');
 const beforeWord=pdfBefore.words.CellAlpha,afterWord=pdfAfter.words.CellAlpha,widthRatio=(afterWord[2]-afterWord[0])/(beforeWord[2]-beforeWord[0]),heightRatio=(afterWord[3]-afterWord[1])/(beforeWord[3]-beforeWord[1]);
 assert(Math.abs(widthRatio-.85)<.015);assert(Math.abs(heightRatio-1.2)<.015);assert(pdfBefore.captions.length&&pdfAfter.captions.length);
 const cb=pdfBefore.captions[0].bbox,ca=pdfAfter.captions[0].bbox;assert(Math.abs((ca[3]-ca[1])/(cb[3]-cb[1])-1)<.01,'Caption font size must stay unchanged');
 // Move complete floats and verify the actual output moves past the requested body anchors.
 const objectTarget=(from,to,text)=>({file:'main.tex',from,to,text,kind:'source',mode:'latex',label:'object'});
 const imageTarget=graphics(source)[0],destination={...paragraphTarget(source,source.indexOf('SecondAnchor')),file:'main.tex'},imageOldY=imageRectangles(rows())[0].y;
 const imageMove=moveObject([{name:'main.tex',content:source}],objectTarget(imageTarget.from,imageTarget.to,imageTarget.text),destination,false,{placement:'near'})[0];source=imageMove.after;const imageMoveMs=await update(source);
 const imageNew=imageRectangles(rows())[0];assert(imageNew.y<imageOldY);assert(imageNew.y+imageNew.h<locate('SecondAnchor').y);
 const tableMoveTarget={...paragraphTarget(source,source.indexOf('\\begin{tabular}')),file:'main.tex'},tableDestination={...paragraphTarget(source,source.indexOf('ThirdAnchor')),file:'main.tex'},tableOldY=locate('CellAlpha').y;
 const tableMove=moveObject([{name:'main.tex',content:source}],tableMoveTarget,tableDestination,false,{placement:'near'})[0];source=tableMove.after;const tableMoveMs=await update(source);
 // Use native PDF text coordinates because the table's glyphs now have a scale transform.
 const movedPdf=await pdfSnapshot('moved-objects');assert(movedPdf.words.CellAlpha[1]<movedPdf.words.ThirdAnchor[1]);assert(locate('CellAlpha').y<tableOldY||movedPdf.words.CellAlpha[1]<movedPdf.words.ThirdAnchor[1]);
 assert(source.includes('\\emph{preserved emphasis}'));assert(source.includes('\\caption{Preserved figure caption.}\\label{fig:keep}'));assert(source.includes('\\caption{Preserved table caption.}\\label{tab:keep}'));
 assert.equal(await fs.readFile(path.join(root,'main.tex'),'utf8'),original);
 const output={pages:pages.size,imageWidthRatio:Number((imageAfter.w/imageBefore.w).toFixed(4)),imageGlobalLayoutMs:Math.round(imageMs),tableColumnGrowthBp:Number(((secondAfter.x-cellAfter.x-secondBefore.x+cellBefore.x)/65781.76).toFixed(2)),tableRowGrowthBp:Number(((rowAfter.y-cellAfter.y-rowBefore.y+cellBefore.y)/65781.76).toFixed(2)),tableGlobalLayoutMs:Math.round(tableMs),paragraphOrderChangedInTypesetOutput:true,moveGlobalLayoutMs:Math.round(moveMs),independentImageAxes:{width:Number((afterAxes.w/beforeAxes.w).toFixed(3)),height:Number((afterAxes.h/beforeAxes.h).toFixed(3)),layoutMs:Math.round(axesMs)},independentTableAxes:{width:Number(widthRatio.toFixed(3)),height:Number(heightRatio.toFixed(3)),layoutMs:Math.round(freeTableMs)},figureMovedInOutput:true,figureMoveMs:Math.round(imageMoveMs),tableMovedInOutput:true,tableMoveMs:Math.round(tableMoveMs),captionFontSizePreserved:true,captionsLabelsAndFormattingPreserved:true,sourceFilesUnchanged:true};
 await fs.writeFile('.runtime/page-tools/result.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));
}finally{await fs.writeFile('.runtime/page-tools/events.json',JSON.stringify(events));if(ws.readyState===1)ws.send(JSON.stringify({type:'stop'}));ws.close();await bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));}

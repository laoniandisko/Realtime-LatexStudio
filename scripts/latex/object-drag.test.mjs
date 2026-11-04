import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
const bundle=await build({stdin:{contents:"export {RealtimePreview} from './src/latex/rtex/preview';export {paragraphTarget} from './src/latex/rtex/block-edit';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'no-pdf-browser',setup(build){build.onResolve({filter:/^pdfjs-dist$/},()=>({path:'pdf',namespace:'stub'}));build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export function getDocument(){throw Error("No browser PDF expected");}'}));}}]});
await fs.mkdir('.runtime/test-bundles',{recursive:true});const bundleFile=path.resolve('.runtime/test-bundles/object-drag.mjs');await fs.writeFile(bundleFile,bundle.outputFiles[0].text);
const {RealtimePreview,paragraphTarget}=await import(pathToFileURL(bundleFile));
function fixture(){
 let text='\\begin{document}\nFirst paragraph.\n\n\\begin{figure}[t]\n\\includegraphics{image.pdf}\n\\caption{Keep caption}\\label{fig:keep}\n\\end{figure}\n\nLast paragraph.\n\\end{document}',source=text;
 const preview=Object.create(RealtimePreview.prototype),classes={add(){},remove(){}},requests=[],nodeTargets=new WeakMap();
 Object.assign(preview,{enabled:true,version:1,draggedBlock:null,dragFrozenPages:new Set(),hitLayers:new Map([[1,{}]]),targetSources:new WeakMap(),nodeTargets,model:{pages:new Map([[1,{}],[2,{}]])},
  renderQueue:{request:pages=>requests.push([...pages])},ensurePageShells(){},options:{editing:()=>true,files:()=>[{name:'main.tex',content:source}],container:{classList:classes,querySelectorAll:()=>[]},viewport:{scrollTop:0,getBoundingClientRect:()=>({top:0,bottom:700})},
   editFiles:changes=>{for(const change of changes){assert.equal(change.before,source);source=change.after;}return true;},notify:()=>{},},closeEditor(){},requestLayout(){}});
 const at=text.indexOf('\\includegraphics'),end=text.indexOf('\n\\caption',at),target={file:'main.tex',from:at,to:end,text:text.slice(at,end),kind:'source',mode:'latex',label:'image'};
 preview.targetSources.set(target,text);
 const event={dataTransfer:{setData(){},effectAllowed:''}};
 return {preview,target,event,requests,text,get source(){return source;},nodeTargets};
}
test('native object dragging keeps rendered source pages stable and still renders newly exposed pages',async()=>{
 const f=fixture();assert(f.preview.startBlockDrag(f.target,f.event));assert(f.preview.draggedBlock.target.text.includes('\\caption{Keep caption}'));assert(f.preview.dragFrozenPages.has(1));
 f.preview.schedule();assert.deepEqual(f.requests.at(-1),[2]);
 await f.preview.paintPage(1,()=>true); // Must return before trying to replace the source DOM/canvas.
 f.preview.clearBlockDrag();assert.deepEqual(f.requests.at(-1),[1,2]);assert.equal(f.preview.dragFrozenPages.size,0);
});
test('drop uses current pointer geometry after a repaint and moves the full caption-bearing float',()=>{
 const f=fixture();assert(f.preview.startBlockDrag(f.target,f.event));const destination={...paragraphTarget(f.source,f.source.indexOf('Last')),file:'main.tex'};
 const region={dataset:{blockKey:'last'},classList:{contains:()=>false,remove(){}},getBoundingClientRect:()=>({top:100,height:200})};
 const node={dataset:{blockKey:'last'},classList:{contains:()=>false}};f.nodeTargets.set(node,destination);f.preview.options.container.querySelectorAll=()=>[region];
 f.preview.dropBlock({target:{closest:()=>node},clientY:280,preventDefault(){},stopPropagation(){}});
 assert(f.source.indexOf('Last paragraph.')<f.source.indexOf('\\begin{figure}'));assert(f.source.includes('\\caption{Keep caption}\\label{fig:keep}'));assert(f.source.includes('\\begin{figure}[!htbp]'));
});

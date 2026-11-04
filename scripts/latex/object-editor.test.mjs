import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {PageObjectEditor} from './src/latex/rtex/object-editor';export {resizeGesture} from './src/latex/rtex/resize-gesture';export {visibleSource} from './src/latex/rtex/vendor/glyphMap';export {sourceSupportsGraphics} from './src/latex/rtex/graphics-support';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {PageObjectEditor,resizeGesture,visibleSource,sourceSupportsGraphics}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const sp=65781.76;
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.style={getPropertyValue:()=> '1'};this.dataset={};this.clientWidth=612;this.width=612;this.height=792;this.value='';}
 append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this;}}
 setAttribute(){}setPointerCapture(){}contains(node){return node===this||this.children.some(child=>child.contains(node));}
 querySelector(tag){return this.children.find(child=>child.tag===tag);}
 getContext(){return {drawImage(){}};}remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
}
const table=String.raw`\begin{table}[t]
\begin{tabular}{cc}A&B\\C&D\\\end{tabular}
\caption{Stay normal}\label{tab:keep}
\end{table}`;
function fixture(kind='image',available=true){
 globalThis.document={activeElement:null,createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){}};
 const page=new Node('page');page.append(new Node('canvas'));let source=kind==='image'?'\\includegraphics[width=.4\\linewidth,clip]{a.pdf}':table,writes=0,moves=0;const notices=[];
 const target={file:'main.tex',from:0,to:source.length,text:source,kind:'source',mode:'latex',label:kind};
 const editor=new PageObjectEditor({target,region:{kind,page:1,x:50*sp,y:80*sp,w:200*sp,h:80*sp,target},page,graphicx:()=>available,
  edit:(from,to,expected,replacement)=>{assert.equal(source,expected);source=replacement;writes++;return true;},boundary(){},close(){},jump(){},notify:message=>notices.push(message),moveStart:()=>{moves++;return true;},moveEnd(){}});
 const handle=name=>editor.element.children.find(node=>node.dataset.handle===name);
 return {editor,page,handle,notices,get source(){return source;},get writes(){return writes;},get moves(){return moves;}};
}
function begin(f,name='se'){const handle=f.handle(name);handle.onpointerdown({button:0,clientX:100,clientY:100,pointerId:1,preventDefault(){},stopPropagation(){}});return handle;}
test('all eight handles are available and a vertical-only corner drag grows both dimensions',()=>{
 const f=fixture(),handles=f.editor.element.children.filter(node=>node.dataset.handle);assert.equal(handles.length,8);
 const handle=begin(f);for(let i=0;i<50;i++)handle.onpointermove({clientX:100,clientY:100+i*80/49,shiftKey:false});assert.equal(f.writes,0);
 handle.onpointerup({clientX:100,clientY:180});assert.equal(f.writes,1);assert(f.source.includes('width=0.8\\linewidth'));assert.equal(f.notices.length,0);f.editor.close();
});
test('an edge handle stretches one image axis and cancel never commits source',()=>{
 const f=fixture(),east=begin(f,'e');east.onpointermove({clientX:200,clientY:300});east.onpointerup({clientX:200,clientY:300});assert.equal(f.writes,1);assert(f.source.includes('width=0.6\\linewidth,height=80bp,keepaspectratio=false'));
 const before=f.source,north=begin(f,'n');north.onpointermove({clientX:100,clientY:20});north.onpointercancel();assert.equal(f.writes,1);assert.equal(f.source,before);f.editor.close();
});
test('table side handles resize the complete table body while caption and label stay outside the scale box',()=>{
 const f=fixture('table'),handle=begin(f,'e');handle.onpointermove({clientX:200,clientY:100});assert.equal(f.writes,0);handle.onpointerup({clientX:200,clientY:100});
 assert.equal(f.writes,1);assert(f.source.includes('\\scalebox{1.5}[1]{\\begin{tabular}'));assert(f.source.includes('}\n\\caption{Stay normal}\\label{tab:keep}'));assert.equal(f.notices.length,0);f.editor.close();
});
test('missing graphics support rejects a table resize without changing the source',()=>{
 const f=fixture('table',false),handle=begin(f);handle.onpointermove({clientX:200,clientY:100});handle.onpointerup({clientX:200,clientY:100});assert.equal(f.source,table);assert.equal(f.writes,0);assert(f.notices.some(message=>message.includes('graphicx')));f.editor.close();
});
test('a preview refresh during dragging cannot erase the resize preview or cancel the final change',()=>{
 const f=fixture(),handle=begin(f);handle.onpointermove({clientX:150,clientY:100});f.editor.refresh({...f.editor.box},f.editor.current);assert(f.editor.element.children.includes(handle));assert(f.page.children.some(node=>node.className==='rtex-object-ghost'));
 handle.onpointerup({clientX:150,clientY:100});assert.equal(f.writes,1);assert(f.source.includes('width=0.5\\linewidth'));f.editor.close();
});
test('dragging the selected object keeps the drag source attached until drop',()=>{
 const f=fixture(),surface=f.editor.element.children.find(node=>node.className==='rtex-object-move-surface');let prevented=false;
 surface.ondragstart({preventDefault(){prevented=true;},dataTransfer:{setDragImage(){}}});assert.equal(f.moves,1);assert(!prevented);assert(f.page.children.includes(f.editor.element));surface.ondragend();f.editor.close();
});
test('top/left resize handles anchor the opposite side and Shift may unlock corner proportions',()=>{
 const box={x:10,y:20,w:100,h:50};assert.deepEqual(resizeGesture(box,'w',-25,100,false),{x:-15,y:20,w:125,h:50});assert.deepEqual(resizeGesture(box,'n',100,-25,false),{x:10,y:-5,w:100,h:75});
 assert.deepEqual(resizeGesture(box,'nw',-25,-5,false),{x:-15,y:15,w:125,h:55});assert.deepEqual(resizeGesture(box,'se',0,50,true),{x:10,y:20,w:200,h:100});
});
test('rendered table cell text never includes non-printing resize or scale dimensions',()=>{
 assert.equal(visibleSource('\\scalebox{1.25}[0.75]{A 1 B}').text,'A 1 B');assert.equal(visibleSource('\\resizebox{.8\\linewidth}{!}{A 1 B}').text,'A 1 B');
});

test('graphics support only follows the main input/package graph, not unrelated supplementary files',()=>{
 const files=[{name:'main.tex',content:'\\documentclass{article}\n\\input{body}'},{name:'body.tex',content:'Text'},{name:'supplementary.tex',content:'\\usepackage{graphicx}'}];
 assert.equal(sourceSupportsGraphics(files,'main.tex'),false);files[1].content='\\usepackage{local}';files.push({name:'local.sty',content:'\\RequirePackage{graphics}'});assert.equal(sourceSupportsGraphics(files,'main.tex'),true);
 assert.equal(sourceSupportsGraphics([{name:'main.tex',content:'% \\usepackage{graphicx}\nText'}],'main.tex'),false);
});

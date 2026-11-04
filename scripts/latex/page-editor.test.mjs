import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './src/latex/rtex/visual-text';export {PageEditor} from './src/latex/rtex/page-editor';export {analyzeUnit} from './src/latex/rtex/analyze-unit';export {formulaTarget,mathRegions} from './src/latex/rtex/block-edit';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {visualText,replaceVisual,changeAtSelection,PageEditor,analyzeUnit,formulaTarget,mathRegions,OBJECT}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('visual editing crosses original TeX lines and formatting without deleting wrappers or citation keys',()=>{
 const original='Before \\emph{global} geometric\nregularization \\citep{wang2021neus} and $x^2$ after.';
 const p=visualText(original);assert.equal(p.text,`Before global geometric regularization ${OBJECT} and ${OBJECT} after.`);
 const from=p.text.indexOf('obal'),to=p.text.indexOf('regularization');
 const next=replaceVisual(original,from,to,'new ');
 assert.equal(next,'Before \\emph{glnew }regularization \\citep{wang2021neus} and $x^2$ after.');
 assert(next.includes('\\emph{'));assert(next.includes('\\citep{wang2021neus}'));assert(next.includes('$x^2$'));
});
test('native selection disambiguates repeated letters with different formatting',()=>{
 const source='\\emph{aa}a',change=changeAtSelection('aaa','aa',0,1,'deleteContentBackward');
 assert.equal(replaceVisual(source,change.from,change.to,change.inserted),'\\emph{a}a');
 assert.deepEqual(changeAtSelection('aaa','aa',1,1,'deleteContentBackward'),{from:0,to:1,inserted:''});
});
test('literal TeX control characters round trip as visible text without changing the preamble',()=>{
 const source='A \\textbf{word} Z',p=visualText(source),at=p.text.indexOf('word');
 const typed='50% & $x_1$ ~ ^ \\ {ok}';const next=replaceVisual(source,at,at+4,typed);
 assert.equal(visualText(next).text,'A '+typed+' Z');assert(next.includes('\\textbf{50\\% \\& \\$x\\_1\\$'));
});
test('math and generated references are atomic; deleting one never damages adjacent markup',()=>{
 const source='See \\citep[cf.][3]{key} and $\\frac{a}{b}$ now.',p=visualText(source),index=p.text.lastIndexOf(OBJECT);
 assert.equal(replaceVisual(source,index,index+1,''),'See \\citep[cf.][3]{key} and  now.');
 const reference=p.text.indexOf(OBJECT);assert.equal(replaceVisual(source,reference,reference+1,'them'),'See them and $\\frac{a}{b}$ now.');
});

class Element {
 constructor(tag){this.tag=tag;this.children=[];this.style={getPropertyValue:name=>name==='--scale-factor'?'1':''};this.value='';this.selectionStart=this.selectionEnd=0;this.selectionDirection='forward';this.clientWidth=600;this.events=new Map();this.classList={toggle:()=>{}};}
 append(...nodes){for(const node of nodes){this.children.push(node);node.parentElement=this;}}
 replaceChildren(){this.children=[];}
 setAttribute(){} addEventListener(name,callback){this.events.set(name,callback);} removeEventListener(name){this.events.delete(name);}
 focus(){document.activeElement=this;} setSelectionRange(start,end,direction='forward'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
 setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.setSelectionRange(start+text.length,start+text.length);}
 getBoundingClientRect(){return {left:100,top:100,width:600,height:800};}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
}
function create(source,kind='paragraph',from=0,to=source.length){
 const body=new Element('body'),page=new Element('page'),container=new Element('container');page.style.width='600px';container.querySelector=selector=>selector==='[data-page="1"]'?page:null;
 globalThis.document={body,activeElement:null,createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};
 globalThis.window={addEventListener(){},removeEventListener(){}};
 let value=source,writes=0,closed=0,boundaries=0,external=false;const cursors=[];
 const editor=new PageEditor({target:{file:'main.tex',from,to,text:source.slice(from,to),kind,mode:kind==='formula'?'latex':'text',label:'paragraph'},container,
  edit:(a,b,expected,replacement)=>{if(external)return false;assert.equal(value.slice(a,b),expected);value=value.slice(0,a)+replacement+value.slice(b);writes++;return true;},
  close:()=>closed++,boundary:()=>boundaries++,notify:()=>{},cursor:(from,to)=>cursors.push({from,to})});
 const text=source.slice(from,to),characters=[];
 for(let i=0;i<text.length;i++)characters.push({page:1,x:(10+(i%12)*7)*65536,y:(20+Math.floor(i/12)*14)*65536,w:7*65536,h:10*65536,from:i,to:i+1});
 editor.updateGeometry(text,characters);
 return {editor,page,body,characters,cursors,get source(){return value;},get writes(){return writes;},get closed(){return closed;},get boundaries(){return boundaries;},external:()=>external=true};
}
function input(fixture,start,end,text,type='insertText'){
 const input=fixture.editor.input;input.setSelectionRange(start,end);input.onbeforeinput({inputType:type,preventDefault(){}});input.setRangeText(text,start,end);input.oninput();
}
test('page input stays focused while live geometry/reflow changes; undo restores original TeX',()=>{
 const original='Before \\emph{global} text after.',f=create(original),inputElement=f.editor.input;
 assert.equal(f.body.children.length,1);assert.equal(inputElement.tag,'textarea');assert.equal(document.activeElement,inputElement);
 input(f,7,13,'local');assert.equal(f.source,'Before \\emph{local} text after.');assert.equal(f.writes,1);
 f.editor.updateGeometry(f.editor.current,f.characters.map(g=>({...g,y:g.y+30000})));assert.equal(document.activeElement,inputElement);assert.equal(inputElement.selectionStart,12);
 let prevented=false;inputElement.onkeydown({key:'z',ctrlKey:true,preventDefault(){prevented=true;}});assert(prevented);assert.equal(f.source,original);
 inputElement.onkeydown({key:'z',ctrlKey:true,shiftKey:true,preventDefault(){}});assert.equal(f.source,'Before \\emph{local} text after.');
 f.editor.close();assert.equal(f.closed,1);assert.equal(f.boundaries,2);assert.equal(f.body.children.length,0);assert.equal(f.page.children.length,0);
});
test('Chinese IME submits one source edit at composition end, and Enter never sends chat',()=>{
 const f=create('English text.'),el=f.editor.input;el.setSelectionRange(0,7);el.events.get('compositionstart')();
 el.setRangeText('中文',0,7);el.oninput();assert.equal(f.writes,0);el.events.get('compositionend')();assert.equal(f.writes,1);assert.equal(f.source,'中文 text.');f.editor.close();
});
test('formula input edits only the expression and preserves the equation environment, label and numbering',()=>{
 const source='\\begin{equation}\\label{eq:keep}\n x^2 + y^2\n\\end{equation}',target=formulaTarget(source,mathRegions(source)[0]),f=create(source,'formula',target.from,target.to);
 input(f,0,f.editor.input.value.length,'\\frac{a}{b}');assert.equal(f.source,'\\begin{equation}\\label{eq:keep}\n \\frac{a}{b}\n\\end{equation}');
 assert(f.editor.input.className.includes('rtex-page-formula-input'));f.editor.close();
});
test('an external edit safely closes the active input instead of overwriting newer source',()=>{
 const f=create('Do not overwrite.');f.external();input(f,0,2,'Never');assert.equal(f.source,'Do not overwrite.');assert.equal(f.closed,1);
});
test('worker geometry preserves ligature source positions and individual line/page coordinates',()=>{
 const size=655360,rows=[{page:1,dx:0,dy:0,dl:{fonts:{0:{size}}},line:{x:0,y:size,w:size,h:size,d:0,items:[['g',0,12,null,0,size,size,0],['g',0,116,null,size,size,size,0]]}}];
 const result=analyzeUnit(rows,'fit');assert.equal(result.characters.length,3);assert.deepEqual(result.characters.map(g=>[g.from,g.to]),[[0,1],[1,2],[2,3]]);assert(result.characters[1].x>result.characters[0].x);
});
test('page caret and selection synchronize to exact raw characters through formatting wrappers',()=>{
 const source='Before \\emph{global} after.',f=create(source);f.editor.input.setSelectionRange(7,13);f.editor.input.onselect();
 const last=f.cursors.at(-1);assert.equal(last.from,source.indexOf('global'));assert.equal(last.to,source.indexOf('global')+6);assert.equal(document.activeElement,f.editor.input);f.editor.close();
});

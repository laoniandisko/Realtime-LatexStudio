import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {moveParagraph} from './src/latex/rtex/paragraph-move';export * from './src/latex/rtex/object-edit';export {paragraphTarget} from './src/latex/rtex/block-edit';export {PageObjectEditor} from './src/latex/rtex/object-editor';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {moveParagraph,graphics,resizeGraphic,tableSetting,tableValues,imageRectangles,objectRegions,paragraphTarget,PageObjectEditor}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const target=(source,word,file='main.tex')=>({...paragraphTarget(source,source.indexOf(word)),file});

test('dragging a complete paragraph reorders source and preserves markup, labels and adjacent structures',()=>{
 const original='\\section{One}\n\nFirst \\emph{important} paragraph \\cite{key}.\n\nSecond paragraph.\n\n\\begin{figure}\\caption{Keep}\\label{fig:keep}\\end{figure}\n\nThird paragraph.';
 const a=target(original,'First'),b=target(original,'Second'),c=target(original,'Third');
 const moved=moveParagraph([{name:'main.tex',content:original}],a,c,true)[0].after;
 assert(moved.indexOf('Third')<moved.indexOf('First'));assert(moved.includes(a.text));assert(moved.includes('\\begin{figure}\\caption{Keep}\\label{fig:keep}\\end{figure}'));
 const before=moveParagraph([{name:'main.tex',content:original}],c,b,false)[0].after;
 assert(before.indexOf('Third')<before.indexOf('Second'));assert.equal(before.match(/Third/g).length,1);assert.equal(before.match(/First/g).length,1);
 assert.deepEqual(moveParagraph([{name:'main.tex',content:original}],a,a,false),[]);
});
test('cross-file movement is a two-file transaction, with exact before snapshots for conflict detection',()=>{
 const a='One \\textbf{paragraph}.\n\nStay here.',b='Destination paragraph.\n\nLeave this.';
 const changes=moveParagraph([{name:'a.tex',content:a},{name:'b.tex',content:b}],target(a,'One','a.tex'),target(b,'Destination','b.tex'),true);
 assert.equal(changes.length,2);assert.equal(changes[0].before,a);assert.equal(changes[1].before,b);assert.equal(changes[0].after,'Stay here.');assert(changes[1].after.includes('Destination paragraph.\n\nOne \\textbf{paragraph}.\n\nLeave'));
});
test('moves reject stale targets, partial blocks and crossing list/abstract/local-group boundaries',()=>{
 const source='Outside.\n\n\\begin{abstract}\nInside.\n\\end{abstract}\n\nLast.';
 assert.throws(()=>moveParagraph([{name:'main.tex',content:source}],target(source,'Inside'),target(source,'Outside'),false),/边界/);
 const a=target(source,'Outside');assert.throws(()=>moveParagraph([{name:'main.tex',content:source.replace('Outside','Changed')}],a,target(source,'Last'),true),/改变/);
 const grouped='Root.\n\n{\\small\n\nGrouped.\n\n}\n\nOther.';assert.throws(()=>moveParagraph([{name:'main.tex',content:grouped}],target(grouped,'Grouped'),target(grouped,'Other'),true),/边界/);
 const list='\\begin{itemize}\n\\item First item.\n\\item Second item.\n\\end{itemize}';assert.throws(()=>moveParagraph([{name:'main.tex',content:list}],target(list,'First'),target(list,'Second'),true),/边界/);
});
test('image resize preserves original units, crop, rotation, file and aspect ratio; scale applies once',()=>{
 const source='\\includegraphics[width=0.8\\linewidth,height=6cm,scale=0.9,trim={1 2 3 4},clip,angle=15]{imgs/a.pdf}';
 const next=resizeGraphic(source,.5,300);
 assert(next.includes('width=0.4\\linewidth,height=3cm,scale=0.9'));assert(next.includes('trim={1 2 3 4},clip,angle=15'));assert(next.endsWith('{imgs/a.pdf}'));
 assert.equal(resizeGraphic('\\includegraphics{a.pdf}',1.2,100),'\\includegraphics[width=120.000bp]{a.pdf}');
 assert.equal(resizeGraphic('\\includegraphics[scale=2]{a.pdf}',.5,100),'\\includegraphics[scale=1]{a.pdf}');
 assert.equal(resizeGraphic('\\includegraphics[width=\\textwidth,clip]{a.pdf}',.75,100),'\\includegraphics[width=0.75\\textwidth,clip]{a.pdf}');
 assert.throws(()=>resizeGraphic('\\includegraphics[width=\\customwidth]{a.pdf}',.5,100),/自定义宏/);
 assert.equal(graphics('% \\includegraphics{ignored}\n\\includegraphics[width=.5\\linewidth]{actual}').length,1);
});

test('image drag previews every pointer move but commits one source edit on release',()=>{
 class Node {
  constructor(tag){this.tag=tag;this.children=[];this.style={getPropertyValue:()=> '1'};this.dataset={};this.clientWidth=600;this.width=600;this.height=800;}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this;}}
  setAttribute(){}setPointerCapture(){}contains(node){return node===this||this.children.some(child=>child.contains(node));}
  querySelector(tag){return this.children.find(child=>child.tag===tag);}
  getContext(){return {drawImage(){}};}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
 }
 globalThis.document={createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){}};
 const page=new Node('page');page.append(new Node('canvas'));let source='\\includegraphics[width=.4\\linewidth,clip]{a.pdf}',writes=0;
 const target={file:'main.tex',from:0,to:source.length,text:source,kind:'source',mode:'latex',label:'image'};
 const editor=new PageObjectEditor({target,region:{kind:'image',page:1,x:50*65781.76,y:70*65781.76,w:200*65781.76,h:80*65781.76,target},page,
  edit:(from,to,expected,replacement)=>{assert.equal(source,expected);source=replacement;writes++;return true;},boundary(){},close(){},jump(){},notify:message=>assert.fail(message)});
 const handle=editor.element.children.find(node=>node.className?.split(' ').includes('rtex-image-resize'));handle.onpointerdown({clientX:100,clientY:100,pointerId:1,preventDefault(){},stopPropagation(){}});
 for(let i=1;i<=50;i++)handle.onpointermove({clientX:100+i*2,clientY:100});assert.equal(writes,0);assert(page.children.some(node=>node.className==='rtex-object-ghost'));
 handle.onpointerup();assert.equal(writes,1);assert(source.includes('width=0.6\\linewidth,clip'));editor.close();assert(!page.children.some(node=>node.className==='rtex-object-ghost'));
});
test('table spacing is local and leaves data, math, caption and label intact',()=>{
 const source='\\begin{table}[t]\n\\centering\n\\begin{tabular}{lc}\\toprule\nMethod & $x^2$ \\\\\nA & 0.9 \\\\\n\\bottomrule\\end{tabular}\n\\caption{Keep this caption}\\label{tab:keep}\n\\end{table}';
 const next=tableSetting(tableSetting(source,'columns',9.5),'rows',1.25);
 assert(next.startsWith('\\begin{table}[t]\n\\renewcommand{\\arraystretch}{1.25}'));assert(next.includes('\\setlength{\\tabcolsep}{9.5pt}'));assert(next.includes('Method & $x^2$'));assert(next.includes('\\caption{Keep this caption}\\label{tab:keep}'));
 assert.deepEqual(tableValues(next),{columns:9.5,rows:1.25});assert.equal(tableSetting(next,'columns',10).match(/\\setlength/g).length,1);
 const bare='\\begin{tabular}{cc}a & b \\\\ \\end{tabular}',local=tableSetting(bare,'columns',7);assert(local.startsWith('{\\setlength'));assert(local.endsWith('}'));assert(local.includes(bare));
});
test('PDF-import placeholder geometry follows graphics transforms and excludes text/rules',()=>{
 const sp=65781.76,rows=[{page:2,dx:0,dy:0,line:{items:[['M','save',100*sp,200*sp,''],['M','set',100*sp,200*sp,'.5 0 0 .5'],['r',100*sp,0,200*sp,200*sp],['M','restore',100*sp,200*sp,'']]}}];
 const [box]=imageRectangles(rows);assert.equal(box.page,2);assert(Math.abs(box.x/sp-100)<1e-6);assert(Math.abs(box.y/sp-100)<1e-6);assert(Math.abs(box.w/sp-100)<1e-6);
 const source='\\begin{figure}\\includegraphics[width=100bp]{a.pdf}\\end{figure}',objects=objectRegions(rows,source,[]);assert.equal(objects.length,1);assert.equal(objects[0].target.text,'\\includegraphics[width=100bp]{a.pdf}');
 assert.equal(objectRegions(rows,source.replace('\\end{figure}','\\includegraphics{b.pdf}\\end{figure}'),[]).length,0);
});

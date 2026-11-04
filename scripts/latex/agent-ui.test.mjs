import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
await fs.mkdir('.runtime/test-bundles',{recursive:true});
const bundle=await build({stdin:{contents:"export {PageBlockEditor} from './src/latex/rtex/block-editor';export {selectionAfterEdit} from './src/latex/rtex/editor-navigation';export {shouldSendChatKey} from './src/latex/agent-session';export {ChatImages,boundedChatHistory} from './src/latex/chat-images';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const file=path.resolve('.runtime/test-bundles/agent-ui.mjs');await fs.writeFile(file,bundle.outputFiles[0].text);
const {PageBlockEditor,selectionAfterEdit,shouldSendChatKey,ChatImages,boundedChatHistory}=await import(pathToFileURL(file));

class Element {
 constructor(tag){this.tag=tag;this.children=[];this.style={};this.attributes={};this.value='';this.selectionStart=0;this.selectionEnd=0;this.scrollTop=0;this.scrollLeft=0;this.offsetHeight=300;this.offsetWidth=600;this.classList={toggle:()=>{},add:()=>{},remove:()=>{}};}
 append(...children){for(const child of children){this.children.push(child);child.parent=this;}}
 prepend(child){this.children.unshift(child);child.parent=this;}
 replaceChildren(...children){this.children=[];this.append(...children);}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(){}
 querySelector(tag){for(const child of this.children){if(child.tag===tag)return child;const nested=child.querySelector?.(tag);if(nested)return nested;}return null;}
 getBoundingClientRect(){return {left:0,top:0,right:1200,bottom:900,width:1200,height:900};}
 focus(){document.activeElement=this;}
 setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
 setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
}
function dom(){globalThis.document={createElement:tag=>new Element(tag),body:new Element('body'),activeElement:null};globalThis.innerWidth=1400;globalThis.innerHeight=1000;}

test('Enter sends, Shift+Enter inserts a newline, and Chinese composition never submits',()=>{
 const event={key:'Enter',shiftKey:false,altKey:false,isComposing:false,keyCode:13,repeat:false};assert(shouldSendChatKey(event));
 for(const extra of [{shiftKey:true},{isComposing:true},{keyCode:229},{repeat:true},{key:'a'}])assert.equal(shouldSendChatKey({...event,...extra}),false);
});

test('a nested formula returns to the same paragraph, retains edits, caret and scroll, and can open another formula',()=>{
 dom();const original='\\section{Test}\n\nBefore $0.62$ and $x^2$ after.';let source=original,closed=0;const from=original.indexOf('Before'),target={file:'main.tex',from,to:original.length,text:original.slice(from),mode:'latex',kind:'paragraph',label:'整段编辑'};
 const parent=new PageBlockEditor({target,viewport:new Element('viewport'),anchor:new Element('anchor').getBoundingClientRect(),edit:(a,b,expected,replacement)=>{assert.equal(source.slice(a,b),expected);source=source.slice(0,a)+replacement+source.slice(b);return true;},boundary:()=>{},close:()=>closed++,jump:()=>{},formula:()=>{assert.fail('Must retain the parent editor, not replace it');}});
 parent.input.setSelectionRange(target.text.length,target.text.length);parent.input.scrollTop=125;parent.input.scrollLeft=40;
 parent.mathButtons.children[0].onclick();const first=parent.child;assert(first);assert.equal(parent.element.style.display,'none');assert.equal(closed,0);
 first.input.value='\\frac{1}{2}';first.input.oninput();assert(source.includes('$\\frac{1}{2}$'));
 const back=first.element.querySelector('header').children.find(child=>child.textContent==='← 返回整段');assert(back);back.onclick();
 assert.equal(parent.child,null);assert.equal(document.activeElement,parent.input);assert.equal(parent.input.scrollTop,125);assert.equal(parent.input.scrollLeft,40);assert(parent.input.value.includes('\\frac{1}{2}'));assert.equal(parent.input.selectionStart,parent.input.value.length);
 parent.mathButtons.children[1].onclick();const second=parent.child;assert.equal(second.input.value,'x^2');second.input.value='a+b';second.input.oninput();assert(source.includes('$a+b$'));second.close(true);assert(source.includes('$x^2$'));assert(source.includes('$\\frac{1}{2}$'));
 parent.close();assert.equal(closed,1);
});

test('cancelling the paragraph while a child is open reverts the complete edit session',()=>{
 dom();let source='Value $x$ here.';const original=source;const editor=new PageBlockEditor({target:{file:'main.tex',from:0,to:source.length,text:source,kind:'paragraph',mode:'latex',label:'段落'},viewport:new Element('viewport'),anchor:new Element('anchor').getBoundingClientRect(),edit:(from,to,expected,replacement)=>{assert.equal(source.slice(from,to),expected);source=source.slice(0,from)+replacement+source.slice(to);return true;},boundary:()=>{},close:()=>{},jump:()=>{},formula:()=>{}});
 editor.mathButtons.children[0].onclick();editor.child.input.value='x+y';editor.child.input.oninput();editor.close(true);assert.equal(source,original);
 assert.deepEqual(selectionAfterEdit('a $x$ end','a $long$ end',9),{start:12,end:12});
});

test('pasting an image creates an attachment and sends its image payload rather than discarding it',async()=>{
 dom();const notices=[],images=new ChatImages(new Element('container'),message=>notices.push(message)),file=new File([new Uint8Array([137,80,78,71])],'clipboard.png',{type:'image/png'}),input=new Element('textarea');let prevented=false;
 images.paste({clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>file}],getData:()=>''},target:input,preventDefault:()=>{prevented=true;}});assert(prevented);assert.equal(images.count,1);
 globalThis.FileReader=class{readAsDataURL(file){file.arrayBuffer().then(data=>{this.result='data:'+file.type+';base64,'+Buffer.from(data).toString('base64');this.onload();});}};
 const captured=await images.capture();assert.equal(captured.parts[0].type,'image_url');assert(captured.parts[0].image_url.url.startsWith('data:image/png;base64,'));captured.consume();assert.equal(images.count,0);assert.equal(notices.length,0);
});

test('image history bounds retain the latest image and keep older text context',()=>{
 const image='data:image/png;base64,'+'A'.repeat(9*1024*1024),messages=[{role:'user',content:[{type:'text',text:'old context'},{type:'image_url',image_url:{url:image}}]},{role:'user',content:[{type:'text',text:'latest'},{type:'image_url',image_url:{url:image}}]}];
 const limited=boundedChatHistory(messages);assert(limited[0].content.some(part=>part.text==='old context'));assert(!limited[0].content.some(part=>part.type==='image_url'));assert(limited[1].content.some(part=>part.type==='image_url'));
});

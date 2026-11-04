import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const bundle=await build({stdin:{contents:"export {SourceBindings} from './src/latex/rtex/source-bindings';export {utf8ToOffset} from './src/latex/rtex/mapping';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
await fs.mkdir('.runtime/test-bundles',{recursive:true});const file=path.resolve('.runtime/test-bundles/source-bindings-performance.mjs');await fs.writeFile(file,bundle.outputFiles[0].text);
const {SourceBindings,utf8ToOffset}=await import(pathToFileURL(file));
const span=(id,start,end=start,last_revision=1)=>({id,range:{start,end},last_revision});
function validEndpoints(source){const endpoints=[];for(let byte=0;byte<=Buffer.byteLength(source);byte++)try{endpoints.push({byte,offset:utf8ToOffset(source,byte)});}catch(error){assert(error instanceof TypeError);}return endpoints;}

for(const [name,source] of [
 ['empty',''],['ASCII','A plain paragraph.\nNext line.'],['mixed scripts','aé中🙂\nβ𐀀z'],['leading BOM','\ufeffé中🙂z'],['two BOMs','\ufeff\ufeffx'],['internal BOM','x\ufeff中'],['isolated surrogates','A\ud800x\udc00B\ud800\ud800\udc00Z'],
])test('batched offsets equal the existing UTF-8 decoder at every valid byte boundary: '+name,()=>{
 const endpoints=validEndpoints(source),bindings=new SourceBindings(),spans=[...endpoints].reverse().flatMap((point,i)=>[span(i*2+1,point.byte),span(i*2+2,0,point.byte)]);
 bindings.install('main.tex',source,spans,1);
 [...endpoints].reverse().forEach((point,i)=>{const empty=bindings.resolve(i*2+1,1),prefix=bindings.resolve(i*2+2,1);assert.equal(empty.from,point.offset);assert.equal(empty.to,point.offset);assert.equal(prefix.from,0);assert.equal(prefix.to,point.offset);});
});

test('invalid endpoints preserve decoder errors and bindings installed before the failing span',()=>{
 const source='A中🙂Z',bad=[-1,.5,NaN,Infinity,'1',null,Buffer.byteLength(source)+1,2,3,5,6,7];
 for(const endpoint of bad)for(const position of ['start','end']){
  let expected;try{utf8ToOffset(source,endpoint);}catch(error){expected=error;}assert(expected);
  const bindings=new SourceBindings(),range=position==='start'?{start:endpoint,end:0}:{start:0,end:endpoint};
  assert.throws(()=>bindings.install('main.tex',source,[span(1,0,1),{id:2,range,last_revision:1},span(3,0,1)],1),error=>error.constructor===expected.constructor&&error.message===expected.message);
  assert.equal(bindings.resolve(1,1).source,source);assert.equal(bindings.resolve(2,1),null);assert.equal(bindings.resolve(3,1),null);
 }
});

test('a malformed later span still fails only after the earlier binding has been installed',()=>{
 const bindings=new SourceBindings();assert.throws(()=>bindings.install('main.tex','valid',[span(1,0,1),{id:2,range:null,last_revision:1}],1),TypeError);assert.equal(bindings.resolve(1,1).to,1);assert.equal(bindings.resolve(2,1),null);
});

test('partial failed updates preserve both the initial visual snapshot and the preceding new revision',()=>{
 const bindings=new SourceBindings();bindings.install('main.tex','old',[span(7,0,3)],1);
 assert.throws(()=>bindings.install('main.tex','new text',[span(7,0,3,2),span(8,0,999,2),span(9,0,1,2)],2),/Invalid UTF-8 offset/);
 assert.equal(bindings.resolve(7,1).source,'old');assert.equal(bindings.resolve(7,2).source,'new text');assert.equal(bindings.resolve(8,2),null);assert.equal(bindings.resolve(9,2),null);
});

test('history retention, visual last_revision resolution, duplicate snapshots and clear stay unchanged',()=>{
 const bindings=new SourceBindings();for(let revision=1;revision<=50;revision++){const source='revision '+revision;bindings.install('main.tex',source,[span(7,0,Buffer.byteLength(source),revision)],revision);}
 assert.equal(bindings.resolve(7,1).source,'revision 1');assert.equal(bindings.resolve(7,27).source,'revision 1');assert.equal(bindings.resolve(7,28).source,'revision 28');assert.equal(bindings.resolve(7,50).source,'revision 50');
 const latest=bindings.resolve(7,50);bindings.install('main.tex',latest.source,[span(7,0,Buffer.byteLength(latest.source),51)],51);assert.equal(bindings.resolve(7,51),latest);bindings.clear();assert.equal(bindings.resolve(7,100),null);
});

test('normal many-span snapshots allocate no per-endpoint TextEncoder or TextDecoder',()=>{
 const NativeEncoder=globalThis.TextEncoder,NativeDecoder=globalThis.TextDecoder,part='正文🙂abc\n',source=part.repeat(10000),size=Buffer.byteLength(part),spans=Array.from({length:100},(_,i)=>span(i+1,i*100*size,(i+1)*100*size));let encodes=0,decodes=0;
 globalThis.TextEncoder=class extends NativeEncoder{encode(...args){encodes++;return super.encode(...args);}};globalThis.TextDecoder=class extends NativeDecoder{decode(...args){decodes++;return super.decode(...args);}};
 try{const bindings=new SourceBindings();bindings.install('large.tex',source,spans,1);assert.equal(bindings.resolve(100,1).to,source.length);assert.equal(encodes,0);assert.equal(decodes,0);bindings.install('large.tex',source,[],2);assert.equal(encodes,0);}finally{globalThis.TextEncoder=NativeEncoder;globalThis.TextDecoder=NativeDecoder;}
});

test('decoder fallback runs only for an invalid byte boundary and preserves the fatal error',()=>{
 const NativeEncoder=globalThis.TextEncoder,NativeDecoder=globalThis.TextDecoder;let encodes=0,decodes=0;
 globalThis.TextEncoder=class extends NativeEncoder{encode(...args){encodes++;return super.encode(...args);}};globalThis.TextDecoder=class extends NativeDecoder{decode(...args){decodes++;return super.decode(...args);}};
 try{const bindings=new SourceBindings();assert.throws(()=>bindings.install('main.tex','A中🙂Z',[span(1,0,1),span(2,1,2)],1),TypeError);assert.equal(encodes,1);assert.equal(decodes,1);assert.equal(bindings.resolve(1,1).to,1);}finally{globalThis.TextEncoder=NativeEncoder;globalThis.TextDecoder=NativeDecoder;}
});

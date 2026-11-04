import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const bundle=await build({stdin:{contents:"export {RealtimePreview} from './src/latex/rtex/preview';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'no-browser-pdf',setup(b){b.onResolve({filter:/^pdfjs-dist$/},()=>({path:'pdf',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export function getDocument(){throw Error("Unexpected PDF load");}'}));}}]});
await fs.mkdir('.runtime/test-bundles',{recursive:true});const file=path.resolve('.runtime/test-bundles/document-dispatch.mjs');await fs.writeFile(file,bundle.outputFiles[0].text);
const {RealtimePreview}=await import(pathToFileURL(file));
function fixture(){
 const sent=[],notices=[],preview=Object.create(RealtimePreview.prototype);
 Object.assign(preview,{enabled:true,pending:new Map(),inFlight:null,sequence:0,documentTimer:undefined,documentSentAt:-Infinity,latestRevision:1,layoutPending:false,exportPending:false,socket:{readyState:1,send:raw=>sent.push(JSON.parse(raw))},options:{notify:(...args)=>notices.push(args)}});
 return {preview,sent,notices,ack:sequence=>preview.receive({type:'document-ack',sequence,revision:sequence+1}),cleanup:()=>{clearTimeout(preview.documentTimer);preview.enabled=false;}};
}

test('an idle input dispatches in the current call without a fixed debounce timer',()=>{
 const f=fixture();try{f.preview.documentChanged('chapter.tex','first edit');assert.deepEqual(f.sent,[{type:'document',file:'chapter.tex',text:'first edit',sequence:1}]);assert.equal(f.preview.documentTimer,undefined);assert.equal(f.preview.inFlight,1);}finally{f.cleanup();}
});

test('a burst retains only the latest text while one source request is in flight',async()=>{
 const f=fixture();try{
  f.preview.documentChanged('chapter.tex','initial');for(let i=0;i<1000;i++)f.preview.documentChanged('chapter.tex','latest '+i);
  assert.equal(f.sent.length,1);assert.equal(f.preview.pending.size,1);assert.equal(f.preview.pending.get('chapter.tex'),'latest 999');
  await f.ack(999);assert.equal(f.sent.length,1);assert.equal(f.preview.inFlight,1);
  f.preview.documentSentAt=-Infinity;await f.ack(1);assert.equal(f.sent.length,2);assert.equal(f.sent[1].text,'latest 999');assert.equal(f.preview.pending.size,0);assert.equal(f.preview.inFlight,2);
 }finally{f.cleanup();}
});

test('acknowledged rapid edits are rate limited and an explicit flush still sends only the newest pending text',async()=>{
 const f=fixture();try{
  f.preview.documentChanged('main.tex','a');f.preview.documentChanged('main.tex','b');f.preview.documentSentAt=performance.now();await f.ack(1);
  assert.equal(f.sent.length,1);assert.notEqual(f.preview.documentTimer,undefined);f.preview.documentChanged('main.tex','c');assert.equal(f.sent.length,1);
  f.preview.documentSentAt=-Infinity;f.preview.flushDocuments();assert.equal(f.sent.length,2);assert.equal(f.sent[1].text,'c');assert.equal(f.preview.documentTimer,undefined);
 }finally{f.cleanup();}
});

test('layout and export wait for all latest source documents and their acknowledgments',async()=>{
 const f=fixture();try{
  f.preview.documentChanged('a.tex','one');f.preview.documentChanged('b.tex','two');f.preview.requestLayout();f.preview.exportPending=true;f.preview.flushDocuments();assert.equal(f.sent.length,1);
  f.preview.documentSentAt=-Infinity;await f.ack(1);assert.equal(f.sent.length,2);assert.equal(f.sent[1].file,'b.tex');
  await f.ack(2);assert.deepEqual(f.sent.slice(2),[{type:'layout'},{type:'export'}]);assert.equal(f.preview.lastLayoutRequestRevision,3);
 }finally{f.cleanup();}
});

test('a disconnected socket retains source data until it can actually be sent',()=>{
 const f=fixture();try{f.preview.socket.readyState=0;f.preview.documentChanged('main.tex','unsent');assert.equal(f.sent.length,0);assert.equal(f.preview.pending.get('main.tex'),'unsent');assert.equal(f.preview.inFlight,null);f.preview.socket.readyState=1;f.preview.flushDocuments();assert.equal(f.sent[0].text,'unsent');}finally{f.cleanup();}
});

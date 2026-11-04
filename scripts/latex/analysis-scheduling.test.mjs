import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:"export * from './src/latex/rtex/analysis-client';export {PageRenderQueue} from './src/latex/rtex/render-queue';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
await fs.mkdir('.runtime/test-bundles',{recursive:true});
const file=path.resolve('.runtime/test-bundles/analysis-scheduling.mjs');await fs.writeFile(file,bundle.outputFiles[0].text);
const {UnitAnalyzer,AnalysisCancelledError,isAnalysisCancelled,PageRenderQueue}=await import(pathToFileURL(file));
const settle=promise=>promise.then(value=>({value}),error=>({error}));
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
class FixtureWorker {
  static instances=[];
  messages=[];terminated=false;onmessage;onerror;
  constructor(){FixtureWorker.instances.push(this);}
  postMessage(message){this.messages.push(message);}
  complete(result,message=this.messages.at(-1)){this.onmessage({data:{id:message.id,result}});}
  reject(error,message=this.messages.at(-1)){this.onmessage({data:{id:message.id,error}});}
  terminate(){this.terminated=true;}
}
function fixture(withWorker=true){
  const old=globalThis.Worker;FixtureWorker.instances=[];globalThis.Worker=withWorker?FixtureWorker:undefined;
  const analyzer=new UnitAnalyzer();
  return {analyzer,get worker(){return FixtureWorker.instances.at(-1);},cleanup(){analyzer.reset();if(old===undefined)delete globalThis.Worker;else globalThis.Worker=old;}};
}

test('analysis dispatches one job at a time and preserves the exact snapshot of every completed result',async()=>{
  const f=fixture();try{
    const rows=[],first=f.analyzer.analyze(7,rows,'first');assert.equal(f.analyzer.analyze(7,rows,'first'),first);
    const second=f.analyzer.analyze(8,[],'another unit'),obsolete=settle(f.analyzer.analyze(7,[],'obsolete')),newest=f.analyzer.analyze(7,[],'newest');
    assert.deepEqual(f.worker.messages.map(m=>m.source),['first']);assert(isAnalysisCancelled((await obsolete).error));
    f.worker.complete({snapshot:'first'});assert.deepEqual(await first,{snapshot:'first'});assert.deepEqual(f.worker.messages.map(m=>m.source),['first','another unit']);
    f.worker.complete({snapshot:'another unit'});assert.deepEqual(await second,{snapshot:'another unit'});
    f.worker.complete({snapshot:'newest'});assert.deepEqual(await newest,{snapshot:'newest'});
    assert.deepEqual(f.worker.messages.map(m=>m.source),['first','another unit','newest']);
  }finally{f.cleanup();}
});

test('a thousand rapid snapshots clone only the active job and the newest waiting job',async()=>{
  const f=fixture();try{
    const pending=[settle(f.analyzer.analyze(7,[],'revision 0'))];
    for(let i=1;i<=1000;i++)pending.push(settle(f.analyzer.analyze(7,[],'revision '+i)));
    assert.equal(f.worker.messages.length,1);f.worker.complete({revision:0});assert.equal(f.worker.messages.length,2);assert.equal(f.worker.messages[1].source,'revision 1000');
    f.worker.complete({revision:1000});const results=await Promise.all(pending);
    assert.equal(results.filter(r=>isAnalysisCancelled(r.error)).length,999);assert.deepEqual(results[0].value,{revision:0});assert.deepEqual(results.at(-1).value,{revision:1000});
  }finally{f.cleanup();}
});

test('returning to an active snapshot reuses its analysis and cancels a now obsolete waiting edit',async()=>{
  const f=fixture();try{
    const rows=[],first=f.analyzer.analyze(7,rows,'original'),queued=settle(f.analyzer.analyze(7,[],'edit'));
    assert.equal(f.analyzer.analyze(7,rows,'original'),first);assert((await queued).error instanceof AnalysisCancelledError);
    f.worker.complete({original:true});assert.deepEqual(await first,{original:true});assert.equal(f.worker.messages.length,1);
  }finally{f.cleanup();}
});

test('reset rejects active and queued work and late events cannot clear the new worker',async()=>{
  const f=fixture();try{
    const active=settle(f.analyzer.analyze(7,[],'old active')),waiting=settle(f.analyzer.analyze(8,[],'old waiting')),old=f.worker;
    f.analyzer.reset();assert(isAnalysisCancelled((await active).error));assert(isAnalysisCancelled((await waiting).error));assert(old.terminated);
    const next=f.analyzer.analyze(7,[],'new active'),current=f.worker;assert.notEqual(current,old);
    old.complete({stale:true});old.onerror();assert(!current.terminated);assert.equal(current.messages.length,1);
    current.complete({fresh:true});assert.deepEqual(await next,{fresh:true});
  }finally{f.cleanup();}
});

test('a failed analysis is evicted synchronously so the identical snapshot can immediately retry',async()=>{
  const f=fixture();try{
    const rows=[],failed=settle(f.analyzer.analyze(7,rows,'retry'));f.worker.reject('fixture failure');
    const retry=f.analyzer.analyze(7,rows,'retry');assert.equal(f.worker.messages.length,2);assert.equal((await failed).error.message,'fixture failure');
    f.worker.complete({retried:true});assert.deepEqual(await retry,{retried:true});
  }finally{f.cleanup();}
});

test('an older failed promise cannot evict a newer cached snapshot for the same unit',async()=>{
  const f=fixture();try{
    const failed=settle(f.analyzer.analyze(7,[],'old')),rows=[],newer=f.analyzer.analyze(7,rows,'new');
    f.worker.reject('old failed');assert.equal((await failed).error.message,'old failed');
    assert.equal(f.analyzer.analyze(7,rows,'new'),newer);assert.equal(f.worker.messages.length,2);
    f.worker.complete({newer:true});assert.deepEqual(await newer,{newer:true});
  }finally{f.cleanup();}
});

test('worker crashes reject every pending unit and allow a clean retry with a new worker',async()=>{
  const f=fixture();try{
    const first=settle(f.analyzer.analyze(7,[],'first')),second=settle(f.analyzer.analyze(8,[],'second')),worker=f.worker;
    worker.onerror();assert.equal((await first).error.message,'Source mapping worker failed');assert.equal((await second).error.message,'Source mapping worker failed');assert(worker.terminated);
    const next=f.analyzer.analyze(8,[],'second');assert.notEqual(f.worker,worker);f.worker.complete({retry:true});assert.deepEqual(await next,{retry:true});
  }finally{f.cleanup();}
});

test('a structured-clone failure rejects queued work instead of leaving the analysis lane stuck',async()=>{
  const f=fixture();try{
    const first=f.analyzer.analyze(7,[],'first'),second=settle(f.analyzer.analyze(8,[],'second')),third=settle(f.analyzer.analyze(9,[],'third')),old=f.worker;
    old.postMessage=()=>{throw Error('Could not clone display list');};old.complete({first:true});
    assert.deepEqual(await first,{first:true});assert.equal((await second).error.message,'Could not clone display list');assert.equal((await third).error.message,'Could not clone display list');assert(old.terminated);
    const retry=f.analyzer.analyze(8,[],'second');f.worker.complete({retry:true});assert.deepEqual(await retry,{retry:true});
  }finally{f.cleanup();}
});

test('the no-Worker fallback coalesces queued edits and cancels them before reset can analyze stale sources',async()=>{
  const f=fixture(false);try{
    const first=f.analyzer.analyze(7,[],'first'),obsolete=settle(f.analyzer.analyze(8,[],'obsolete')),last=f.analyzer.analyze(8,[],'last');
    assert(isAnalysisCancelled((await obsolete).error));assert.deepEqual(await first,{paragraphs:[],math:[],characters:[],objects:[]});assert.deepEqual(await last,{paragraphs:[],math:[],characters:[],objects:[]});
    const active=settle(f.analyzer.analyze(7,null,'would fail if executed')),queued=settle(f.analyzer.analyze(8,null,'also stale'));
    f.analyzer.reset();assert(isAnalysisCancelled((await active).error));assert(isAnalysisCancelled((await queued).error));await pause();
    assert.deepEqual(await f.analyzer.analyze(7,[],'after reset'),{paragraphs:[],math:[],characters:[],objects:[]});
  }finally{f.cleanup();}
});

test('clean scroll notifications schedule no animation frames and make no visibility reads',async()=>{
  let frames=0,reads=0,callback;const queue=new PageRenderQueue({enabled:()=>true,visible:()=>{reads++;return [1];},frame:cb=>{frames++;callback=cb;return frames;},cancelFrame(){},paint:async()=>{},error:error=>{throw error;},yield:async()=>{}});
  for(let i=0;i<1000;i++)queue.request();assert.equal(frames,0);assert.equal(reads,0);
  queue.request([1]);assert.equal(frames,1);callback();await pause();const afterPaint=reads;
  for(let i=0;i<1000;i++)queue.request();assert.equal(frames,1);assert.equal(reads,afterPaint);queue.reset();
});

test('dirty offscreen work survives until a later scroll exposes its page',async()=>{
  let visible=[1],callback,frames=0;const painted=[],queue=new PageRenderQueue({enabled:()=>true,visible:()=>visible,frame:cb=>{callback=cb;return ++frames;},cancelFrame(){},paint:async page=>{painted.push(page);},error:error=>{throw error;},yield:async()=>{}});
  queue.request([2]);callback();await pause();assert.deepEqual(painted,[]);
  visible=[2];queue.request();callback();await pause();assert.deepEqual(painted,[2]);queue.reset();
});

test('reset during an in-flight paint never loses a newly queued epoch',async()=>{
  let callback,frames=0,release;const painted=[],gate=new Promise(resolve=>release=resolve),queue=new PageRenderQueue({enabled:()=>true,visible:()=>[1,2],frame:cb=>{callback=cb;return ++frames;},cancelFrame(){},paint:async(page,current)=>{painted.push(page);if(page===1){await gate;assert(!current());}},error:error=>{throw error;},yield:async()=>{}});
  queue.request([1]);callback();queue.reset();queue.request([2]);release();await pause();assert.equal(frames,2);callback();await pause();assert.deepEqual(painted,[1,2]);queue.reset();
});

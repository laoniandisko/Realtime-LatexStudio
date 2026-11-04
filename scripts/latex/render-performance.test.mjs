import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled = await build({stdin:{contents:"export * from './src/latex/rtex/render-queue'; export {ImageStore} from './src/latex/rtex/vendor/render'; export {PreviewModel} from './src/latex/rtex/vendor/model'; export {decodeBase64} from './src/latex/binary'; export {reconcileNodes} from './src/latex/rtex/reconcile';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {PageRenderQueue,nearViewport,ImageStore,PreviewModel,decodeBase64,reconcileNodes} = await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve=>setTimeout(resolve,5));
const until = async test => {for(let i=0;i<100;i++){if(test())return;await tick();}assert.fail('Timed out');};
const frames = {frame:cb=>setTimeout(cb,0),cancelFrame:clearTimeout};

test('a burst of edits coalesces, paints only visible pages, and yields to input',async()=>{
  let visible=[1],release,active=0,maxActive=0,heartbeat=false;
  const gate=new Promise(r=>release=r),painted=[];
  const queue=new PageRenderQueue({...frames,enabled:()=>true,visible:()=>visible,error:e=>{throw e;},paint:async(page,current)=>{
    maxActive=Math.max(maxActive,++active);painted.push(page);
    if(painted.length===1)await gate;
    active--;return current();
  }});
  queue.request([1,2,3,4,5,6,7,8,9]);await until(()=>active===1);
  for(let i=0;i<1000;i++)queue.request([1]);
  setTimeout(()=>{heartbeat=true;},0);release();
  await until(()=>painted.length===2&&active===0);await tick();
  assert.deepEqual(painted,[1,1]);assert.equal(maxActive,1);assert(heartbeat);
  visible=[8];queue.request();await until(()=>painted.includes(8));
  assert.deepEqual(painted,[1,1,8]);queue.reset();
});

test('stopping invalidates in-flight rendering and discards queued pages',async()=>{
  let enabled=true,release,validAfterStop;
  const gate=new Promise(r=>release=r),painted=[];
  const queue=new PageRenderQueue({...frames,enabled:()=>enabled,visible:()=>[1,2],error:e=>{throw e;},paint:async(page,current)=>{painted.push(page);await gate;validAfterStop=current();}});
  queue.request([1,2]);await until(()=>painted.length===1);enabled=false;queue.reset();release();await tick();
  assert.equal(validAfterStop,false);assert.deepEqual(painted,[1]);
});

test('image decoding is lazy and bounded even when every figure is requested',async()=>{
  const releases=[];let active=0,maxActive=0,started=0,loaded=0;
  const images=new ImageStore(()=>{started++;maxActive=Math.max(maxActive,++active);return new Promise(resolve=>releases.push(()=>{active--;resolve({});}));});
  images.onLoaded=()=>loaded++;
  for(let i=0;i<20;i++)images.add('figure'+i,{kind:'pdf',data:new Uint8Array()});
  await tick();assert.equal(started,0);
  for(let i=0;i<20;i++)images.get('figure'+i);
  await tick();assert.equal(started,2);
  while(loaded<20){while(releases.length)releases.shift()();await tick();}
  assert.equal(maxActive,2);assert.equal(images.get('figure19').kind,'bitmap');
});

test('line ownership is cached and rebuilt when a new layout moves paragraphs',()=>{
  const model=new PreviewModel();
  const page={page:1,dl:{lines:[{x:10000,y:20000,unit:1},{x:10000,y:40000,unit:2}]}};
  const layout=y=>({pages:[page],pagesTotal:1,placements:[{par_id:7,fragments:[{page:1,x:10000,xs:[10000],baselines:[y]}]}],keepFromRevision:null});
  model.applyLayout(layout(20000));const first=model.ownLines(1,7);
  assert.deepEqual([...first],[0]);assert.equal(model.ownLines(1,7),first);
  model.applyLayout(layout(40000));assert.deepEqual([...model.ownLines(1,7)],[1]);
  assert(nearViewport(100,500,0,400));assert(!nearViewport(2000,2500,0,400));
});

test('large binary decoding preserves bytes and allows input between chunks',async()=>{
  const source=Buffer.alloc(1024*1024+1);for(let i=0;i<source.length;i++)source[i]=i%256;
  let heartbeat=false;setTimeout(()=>{heartbeat=true;},0);
  const decoded=await decodeBase64(source.toString('base64'));
  assert(Buffer.from(decoded).equals(source));
  if(!Uint8Array.fromBase64)assert(heartbeat);
  for(const text of ['','a','ab','abc'])assert.equal(Buffer.from(await decodeBase64(Buffer.from(text).toString('base64'))).toString(),text);
});

test('changing projects drops old image work instead of restoring stale figures',async()=>{
  let release;const images=new ImageStore(()=>new Promise(resolve=>release=resolve));
  images.add('figure',{kind:'pdf',data:new Uint8Array()});images.get('figure');await tick();images.clear();release({});await tick();
  assert.equal(images.get('figure'),undefined);
});


test('editing one paragraph retains the other paragraph hit nodes without moving them',()=>{
 const old={name:'old'},unchanged={name:'unchanged'},next={name:'new'},tail={name:'tail'},mutations=[];
 const children=[old,unchanged,tail];
 const parent={get childNodes(){return children;},get firstChild(){return children[0]||null;},removeChild(node){mutations.push(['remove',node.name]);children.splice(children.indexOf(node),1);},insertBefore(node,before){mutations.push(['insert',node.name]);const existing=children.indexOf(node);if(existing>=0)children.splice(existing,1);children.splice(before?children.indexOf(before):children.length,0,node);}};
 for(const node of [old,unchanged,next,tail])Object.defineProperty(node,'nextSibling',{get(){return children[children.indexOf(node)+1]||null;}});
 reconcileNodes(parent,[next,unchanged,tail]);assert.deepEqual(children,[next,unchanged,tail]);assert.deepEqual(mutations,[['remove','old'],['insert','new']]);
 mutations.length=0;reconcileNodes(parent,[next,unchanged,tail]);assert.equal(mutations.length,0);
});

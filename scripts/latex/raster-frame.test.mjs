import {test} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createCanvas,Path2D} from '@napi-rs/canvas';
const bundle=await build({stdin:{contents:"export {paintRasterFrame} from './src/latex/rtex/raster-frame';export {RealtimePreview} from './src/latex/rtex/preview';export {Painter,FontStore,ImageStore} from './src/latex/rtex/vendor/render';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'no-browser-pdf',setup(build){build.onResolve({filter:/^pdfjs-dist$/},()=>({path:'pdf',namespace:'stub'}));build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export function getDocument(){throw Error("Unexpected PDF load");}'}));}}]});
await fs.mkdir('.runtime/test-bundles',{recursive:true});const file=path.resolve('.runtime/test-bundles/raster-frame.mjs');await fs.writeFile(file,bundle.outputFiles[0].text);
const {paintRasterFrame,RealtimePreview,Painter,FontStore}=await import(pathToFileURL(file));globalThis.Path2D=Path2D;
const sp=65781.76;
const pixels=canvas=>Buffer.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
function background(width,height,frame){const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle=frame%2?'#294fba':'#19a270';ctx.fillRect(width*.55,height*.1,width*.3,height*.35);ctx.fillStyle='#111';ctx.fillRect(12,height*.8,55,3);return canvas;}
function overlay(frame){const x=(16+frame%28)*sp,y=65*sp,line={x,y,w:50*sp,h:10*sp,d:2*sp,items:[['r',x,y,7*sp,3*sp]]};return {line,dl:{fonts:{},other:[],lines:[line]}};}
test('200 reused native Canvas frames equal independently rendered fresh frames, with no retained glyphs or lost figures',()=>{
 const target=createCanvas(160,100),fonts=new FontStore(),images={get:()=>undefined};
 for(let frame=0;frame<200;frame++){
  const base=background(160,100,frame),ov=overlay(frame),reference=createCanvas(160,100),ref=reference.getContext('2d');ref.drawImage(base,0,0);new Painter(ref,[1/sp,0,0,1/sp,0,0],fonts,images).draw(ov.dl,ov.line.items);
  const ctx=target.getContext('2d');if(!frame){ctx.setTransform(.001,0,0,.001,45,33);ctx.globalAlpha=.2;ctx.globalCompositeOperation='destination-over';}
  paintRasterFrame(ctx,base,160,100,()=>new Painter(ctx,[1/sp,0,0,1/sp,0,0],fonts,images).draw(ov.dl,ov.line.items));
  assert(pixels(target).equals(pixels(reference)),`Frame ${frame} retained an old raster or glyph`);assert.equal(ctx.getTransform().a,1);assert.equal(ctx.getTransform().e,0);
 }
});
test('the production paintPage path resets device-pixel state across full layouts and glyph overlays at high DPI',async()=>{
 const scale=1.25,dpr=2,width=160,height=100,pixelWidth=400,pixelHeight=250,canvas=createCanvas(pixelWidth,pixelHeight);canvas.style={};
 globalThis.devicePixelRatio=dpr;const element={style:{setProperty(){}},querySelector:selector=>selector==='canvas'?canvas:{}};
 const model={pages:new Map([[1,{dl:{page_width:width*sp,page_height:height*sp,lines:[],fonts:{},other:[]}}]]),ownLines:()=>new Set()};
 const preview=Object.create(RealtimePreview.prototype),fonts=new FontStore(),images={get:()=>undefined};let ov;
 Object.assign(preview,{version:1,zoom:scale,draggedBlock:null,dragFrozenPages:new Set(),model,fonts,images,bases:new Map(),options:{container:{querySelector:()=>element},viewport:{clientWidth:300}},pageRows:()=>({rows:[],overlays:[{overlay:{parId:1,dl:ov.dl},rows:[{line:ov.line,dx:0,dy:0}]}]}),paintTextLayer:async()=>{}});
 for(let frame=0;frame<40;frame++){
  ov=overlay(frame);const base=background(pixelWidth,pixelHeight,frame);preview.bases.set(1,base);
  const reference=createCanvas(pixelWidth,pixelHeight),ref=reference.getContext('2d');ref.drawImage(base,0,0);new Painter(ref,[scale*dpr/sp,0,0,scale*dpr/sp,0,0],fonts,images).draw(ov.dl,ov.line.items);
  await preview.paintPage(1,()=>true);assert(pixels(canvas).equals(pixels(reference)),`Production paintPage corrupted frame ${frame}`);
 }
});
test('an overlay draw failure cannot leak its transform into the next raster',()=>{
 const canvas=createCanvas(80,60),base=background(80,60,0),ctx=canvas.getContext('2d');
 assert.throws(()=>paintRasterFrame(ctx,base,80,60,()=>{ctx.setTransform(.001,0,0,.001,0,0);throw Error('Incomplete glyph');}),/Incomplete/);
 assert.equal(ctx.getTransform().a,1);paintRasterFrame(ctx,base,80,60,()=>{});assert(pixels(canvas).equals(pixels(base)));
});


test('a page without its full PDF never rasterizes an imported-PDF placeholder as a black figure',async()=>{
 const sp=65781.76,canvas=createCanvas(160,100);canvas.style={};const ctx=canvas.getContext('2d');ctx.fillStyle='#4682b4';ctx.fillRect(0,0,160,100);const before=pixels(canvas);
 const element={style:{setProperty(){}},querySelector:selector=>selector==='canvas'?canvas:{}};
 const line={x:10*sp,y:70*sp,w:100*sp,h:40*sp,d:0,items:[['M',1,0,0,1,0,0],['r',10*sp,20*sp,100*sp,40*sp]]};
 const dl={page_width:160*sp,page_height:100*sp,lines:[line],fonts:{},other:[]},statuses=[];
 globalThis.document={createElement:()=>createCanvas(1,1)};globalThis.devicePixelRatio=1;
 const preview=Object.create(RealtimePreview.prototype);Object.assign(preview,{version:1,zoom:1,document:null,dragFrozenPages:new Set(),model:{pages:new Map([[1,{dl}]])},fonts:new FontStore(),images:{get:()=>undefined},bases:new Map(),options:{container:{querySelector:()=>element},viewport:{clientWidth:300}},status:(...args)=>statuses.push(args)});
 await preview.paintPage(1,()=>true);assert(pixels(canvas).equals(before));assert.equal(preview.bases.size,0);assert(statuses.some(([text])=>text.includes('完整 PDF')));
});

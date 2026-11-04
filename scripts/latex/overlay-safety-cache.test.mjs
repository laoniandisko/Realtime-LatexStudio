import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {overlaySafety,hasStructuredInk} from './src/latex/rtex/overlay-safety';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {overlaySafety,hasStructuredInk}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const sp=65536;
const line=(x,y,w=100)=>({x:x*sp,y:y*sp,w:w*sp,h:7*sp,d:2*sp,items:[['g',0,65,null,(x+2)*sp,y*sp,(w-4)*sp,0]]});
const dl=lines=>({kind:'test',fonts:{0:{size:10*sp}},lines,other:[],width:300*sp,height:500*sp,depth:0,flags:{}});
function fragment(positions){return {page:1,first_line:1,last_line:positions.length,x:positions[0][0]*sp,xs:positions.map(([x])=>x*sp),baselines:positions.map(([,y])=>y*sp),approximate:false};}
function fixture(original=[[10,20],[10,34]],next=original){
 const originals=original.map(([x,y])=>line(x,y)),overlay={parId:7,revision:2,dl:dl(next.map(([,y])=>line(0,y-next[0][1]))),fragments:[fragment(next)]},page={page:1,exact:true,hash:1,dl:dl(originals)},owned=new Set(originals.map((_,i)=>i));
 return {overlay,pages:new Map([[1,page]]),placements:new Map([[7,[fragment(original)]]]),ownLines:()=>owned,owned,page};
}
function countGlyphReads(row){let reads=0;const item=row.items[0],x=item[4];Object.defineProperty(item,4,{get(){reads++;return x;},configurable:true});return ()=>reads;}

test('hot static page geometry is reused without walking its glyphs on every edit',()=>{
 const f=fixture(),readOwn=countGlyphReads(f.page.dl.lines[0]),background=line(150,20),readBackground=countGlyphReads(background);f.page.dl.lines.push(background);
 assert(overlaySafety(f).safe);const first=[readOwn(),readBackground()];assert(first.every(n=>n>0));
 for(let revision=3;revision<=40;revision++){
  f.overlay={...f.overlay,revision,dl:{...f.overlay.dl,lines:f.overlay.dl.lines.map(row=>({...row}))}};assert(overlaySafety(f).safe);
 }
 assert.deepEqual([readOwn(),readBackground()],first);
});

test('a fresh page revision and a replaced display list cannot reuse old safe geometry',()=>{
 const f=fixture();assert(overlaySafety(f).safe);
 const replacement={...f.page,hash:2,dl:dl([line(150,20),line(150,34)])};f.pages.set(1,replacement);
 assert.equal(overlaySafety(f).reason,'missing-placement');
 f.placements.set(7,[fragment([[150,20],[150,34]])]);assert.equal(overlaySafety(f).reason,'slot-overflow');
 f.overlay.fragments=[fragment([[150,20],[150,34]])];assert(overlaySafety(f).safe);
 replacement.dl=dl([line(10,20),line(10,34)]);assert.equal(overlaySafety(f).reason,'missing-placement');
});

test('changing the owned set with equal cardinality rebuilds slots and background collision baselines',()=>{
 const f=fixture([[10,20],[10,34]]);f.page.dl.lines.push(line(10,48));assert(overlaySafety(f).safe);
 f.owned.delete(1);f.owned.add(2);f.placements.set(7,[fragment([[10,20],[10,48]])]);assert.equal(overlaySafety(f).reason,'background-collision');
});

test('mutating anchors in the existing placement arrays cannot leave the old safe slot cached',()=>{
 const f=fixture();assert(overlaySafety(f).safe);const placement=f.placements.get(7)[0];placement.baselines[0]+=5*sp;assert.equal(overlaySafety(f).reason,'missing-placement');
 placement.baselines[0]-=5*sp;assert(overlaySafety(f).safe);placement.xs[0]+=5*sp;assert.equal(overlaySafety(f).reason,'missing-placement');
 placement.xs[0]-=5*sp;assert(overlaySafety(f).safe);
});

test('in-place shape and font size changes invalidate cached glyph bounds',()=>{
 const f=fixture();assert(overlaySafety(f).safe);f.overlay.dl.lines[0].w=130*sp;assert.equal(overlaySafety(f).reason,'slot-overflow');
 f.overlay.dl.lines[0].w=100*sp;assert(overlaySafety(f).safe);f.overlay.dl.fonts[0].size=30*sp;assert.equal(overlaySafety(f).reason,'slot-overflow');
 f.overlay.dl.fonts[0].size=10*sp;assert(overlaySafety(f).safe);
});

test('a changed background shape invalidates its cached collision rectangle',()=>{
 const f=fixture([[10,20],[10,48]],[[10,20],[10,34]]),neighbor=line(150,34);f.page.dl.lines.push(neighbor);assert(overlaySafety(f).safe);
 neighbor.items=[['g',0,65,null,12*sp,34*sp,96*sp,0]];neighbor.x=10*sp;assert.equal(overlaySafety(f).reason,'background-collision');
});

test('accepted overlays and source structure remain live inputs after static cache warmup',()=>{
 const f=fixture([[10,20],[10,48]],[[10,20],[10,34]]);assert(overlaySafety(f).safe);
 const other=fixture([[150,34]],[[150,34]]).overlay;other.parId=8;f.otherOverlays=[other];assert(overlaySafety(f).safe);
 other.fragments=[fragment([[10,34]])];assert.equal(overlaySafety(f).reason,'overlay-collision');
 f.otherOverlays=[];assert(overlaySafety(f).safe);f.structured=true;assert.equal(overlaySafety(f).reason,'structured-content');f.structured=false;assert(overlaySafety(f).safe);
});

test('array replacement or growth rechecks structured ink even after a cached ordinary result',()=>{
 const f=fixture();assert.equal(hasStructuredInk(f.overlay.dl),false);f.overlay.dl.lines[0].items=[['r',0,0,100*sp,100*sp]];assert.equal(hasStructuredInk(f.overlay.dl),true);
 f.overlay.dl.lines[0].items=[['g',0,65,null,2*sp,0,96*sp,0]];assert.equal(hasStructuredInk(f.overlay.dl),false);
 f.overlay.dl.other.push(['M','set',0,0,'.5 0 0 .5']);assert.equal(hasStructuredInk(f.overlay.dl),true);
});


test('omitting optional other commands still reuses the static page cache',()=>{
 const f=fixture();delete f.page.dl.other;delete f.overlay.dl.other;const reads=countGlyphReads(f.page.dl.lines[0]);assert(overlaySafety(f).safe);const first=reads();assert(first>0);
 for(let i=0;i<20;i++)assert(overlaySafety(f).safe);assert.equal(reads(),first);
});

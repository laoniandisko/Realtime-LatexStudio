import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {overlaySafety} from './src/latex/rtex/overlay-safety';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {overlaySafety}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const p=65536;
const line=(x,y,w=100)=>({x:x*p,y:y*p,w:w*p,h:7*p,d:2*p,items:[['g',0,65,null,(x+2)*p,y*p,(w-4)*p,0]]});
const dl=lines=>({kind:'test',fonts:{0:{size:10*p}},lines,other:[],width:200*p,height:500*p,depth:0,flags:{}});
function fragment(page,first,positions,approximate=false){return {page,first_line:first,last_line:first+positions.length-1,x:positions[0][0]*p,xs:positions.map(([x])=>x*p),baselines:positions.map(([,y])=>y*p),approximate};}
function fixture(original=[[10,20],[10,34]],next=original){
 const lines=original.map(([x,y])=>line(x,y)),placed=fragment(1,1,original),overlay={parId:7,revision:2,dl:dl(next.map(([,y])=>line(0,y-next[0][1]))),fragments:[fragment(1,1,next)]};
 const pages=new Map([[1,{page:1,exact:true,hash:1,dl:dl(lines)}]]),owned=new Set(lines.map((_,i)=>i)),placements=new Map([[7,[placed]]]);
 return {overlay,pages,placements,ownLines:()=>owned,owned};
}
test('same-slot prose remains eligible even when shared metadata names images elsewhere in the paper',()=>{
 const f=fixture();f.overlay.dl.images_info={1:{file:'unrelated.pdf'}};assert.deepEqual(overlaySafety(f),{safe:true,reason:null});
 f.overlay.dl.lines[0].items[0][2]=66;assert(overlaySafety(f).safe);
});
test('shorter paragraphs remain local but new lines cannot spill into following body text',()=>{
 const shorter=fixture([[10,20],[10,34],[10,48]],[[10,20],[10,34]]);assert(overlaySafety(shorter).safe);
 const grows=fixture([[10,20],[10,34]],[[10,20],[10,34],[10,48]]);grows.pages.get(1).dl.lines.push(line(10,48));assert.equal(overlaySafety(grows).reason,'line-growth');
});
test('approximate, orphan and unmatched original placements wait for authoritative layout',()=>{
 const approximate=fixture();approximate.overlay.fragments[0].approximate=true;assert.equal(overlaySafety(approximate).reason,'approximate-placement');
 const orphan=fixture();orphan.owned.clear();assert.equal(overlaySafety(orphan).reason,'missing-placement');
 const wrong=fixture();wrong.placements.get(7)[0].baselines[0]+=p*5;assert.equal(overlaySafety(wrong).reason,'missing-placement');
});
test('a same-page two-column paragraph may update in its real slots but cannot flatten right-column lines into the left',()=>{
 const positions=[[10,20],[10,34],[150,20],[150,34]],f=fixture(positions);assert(overlaySafety(f).safe);
 f.overlay.fragments=[fragment(1,1,[[10,20],[10,34],[10,48],[10,62]])];assert.equal(overlaySafety(f).reason,'slot-overflow');
});
test('a shifted line cannot enter the inter-column gap or grow outside its old horizontal slot',()=>{
 const gap=fixture([[10,20],[150,20]],[[10,20],[100,20]]);assert.equal(overlaySafety(gap).reason,'slot-overflow');
 const wider=fixture();wider.overlay.dl.lines[0].w=130*p;assert.equal(overlaySafety(wider).reason,'slot-overflow');
});
test('two new rows at the same baseline cannot paint on top of each other',()=>{
 const f=fixture([[10,20],[10,34]],[[10,20],[10,20]]);assert.equal(overlaySafety(f).reason,'self-overlap');
});
test('new overlap with unrelated page ink is rejected, while existing tight font boxes are tolerated',()=>{
 const f=fixture([[10,20],[10,48]],[[10,20],[10,34]]);
 // The large old paragraph gap still belongs to its region, but another unit owns ink there.
 f.pages.get(1).dl.lines.push(line(10,34));assert.equal(overlaySafety(f).reason,'background-collision');
 const tight=fixture([[10,20]]);tight.pages.get(1).dl.lines.push(line(10,29));assert(overlaySafety(tight).safe);
});
test('accepted overlays on the same page cannot newly intersect each other',()=>{
 const f=fixture([[10,20],[10,48]],[[10,20],[10,34]]);
 const other=fixture([[10,34]],[[10,34]]).overlay;other.parId=8;f.otherOverlays=[other];assert.equal(overlaySafety(f).reason,'overlay-collision');
});
test('page crossings require old slots on every page and preserve each page/column anchor',()=>{
 const f=fixture();f.pages.set(2,{page:2,exact:true,hash:2,dl:dl([line(150,20)])});f.placements.set(7,[fragment(1,1,[[10,20],[10,34]]),fragment(2,3,[[150,20]])]);
 f.overlay.dl.lines.push(line(0,28));f.overlay.fragments.push(fragment(2,3,[[150,20]]));f.ownLines=page=>page===1?new Set([0,1]):new Set([0]);assert(overlaySafety(f).safe);
 f.overlay.fragments[1].page=3;assert.equal(overlaySafety(f).reason,'missing-placement');
});
test('actual picture/matrix placeholders and source-declared structure never become black fast-layer rules',()=>{
 const transformed=fixture();transformed.overlay.dl.lines[0].items.unshift(['M','set',0,0,'.5 0 0 .5']);assert.equal(overlaySafety(transformed).reason,'structured-content');
 const picture=fixture();picture.overlay.dl.lines[0].items=[['r',0,0,100*p,100*p]];assert.equal(overlaySafety(picture).reason,'structured-content');
 const source=fixture();source.structured=true;assert.equal(overlaySafety(source).reason,'structured-content');
});
test('malformed fragment ranges and missing geometry cannot partially replace a PDF unit',()=>{
 const f=fixture();f.overlay.fragments[0].last_line++;assert.equal(overlaySafety(f).reason,'invalid-geometry');
 const invalid=fixture();invalid.overlay.fragments[0].xs[0]=NaN;assert.equal(overlaySafety(invalid).reason,'invalid-geometry');
});

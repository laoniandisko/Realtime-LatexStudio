import type { Overlay, OverlayRow } from './vendor/model';
import type { DisplayList, Fragment, Line, PageUpdate } from './vendor/protocol';
import { SP_PER_PT } from './vendor/protocol';

export type OverlayUnsafeReason = 'structured-content' | 'approximate-placement' | 'missing-placement' |
  'invalid-geometry' | 'line-growth' | 'slot-overflow' | 'self-overlap' | 'background-collision' | 'overlay-collision';
export type OverlaySafety = {safe:true;reason:null} | {safe:false;reason:OverlayUnsafeReason;page?:number};
export interface OverlaySafetyInput {
  overlay:Overlay;
  pages:ReadonlyMap<number,PageUpdate>;
  ownLines(page:number,parId:number):ReadonlySet<number>;
  placements?:ReadonlyMap<number,readonly Fragment[]>;
  /** Pass accepted overlays, not overlays that have already been rejected. */
  otherOverlays?:Iterable<Overlay>;
  /** Source bindings may know that the unit is a figure/table before ink inspection. */
  structured?:boolean;
}
interface Rect {x:number;y:number;w:number;h:number}
interface Ink {page:number;rect:Rect;baseline:number}
interface Slot {rect:Rect;rows:Ink[]}
interface LineGeometry {
  items:Line['items'];length:number;x:number;y:number;w:number;h:number;d:number;
  rect:Rect|null;structured:boolean;
}
interface DisplayGeometry {
  fonts:DisplayList['fonts'];lines:DisplayList['lines'];other:DisplayList['other'];lineCount:number;otherCount:number;
  fontSize:number;otherStructured:boolean;byLine:WeakMap<Line,LineGeometry>;epoch:number;fontSnapshot:{key:string;size:number|null|undefined}[];
}
interface AnchorSnapshot {x:number;xs:number[];baselines:number[];approximate:boolean}
interface OldGeometry {
  indices:number[];lines:Line[];geometry:LineGeometry[];anchors:AnchorSnapshot[]|null;
  old:Ink[];regions:Slot[];internalOverlap:number;overlapBaseline:WeakMap<Rect,number>;
}
// Native display-list payloads and glyph items are immutable within a revision.
// Weak keys allow old layouts, units and source revisions to be collected. The
// cheap shape/reference checks also tolerate replacement/resize of public arrays.
const displayGeometry=new WeakMap<DisplayList,DisplayGeometry>();
const oldGeometry=new WeakMap<PageUpdate,Map<string,OldGeometry>>();
let geometryEpoch=0;
const EMPTY_ITEMS:Line['items']=[];
const EPS=SP_PER_PT*.55;
const ANCHOR_EPS=128;
const right=(r:Rect)=>r.x+r.w,bottom=(r:Rect)=>r.y+r.h;
function union(a:Rect,b:Rect):Rect {const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return {x,y,w:Math.max(right(a),right(b))-x,h:Math.max(bottom(a),bottom(b))-y};}
function valid(r:Rect){return [r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>=0&&r.h>=0;}
function contains(a:Rect,b:Rect){return b.x>=a.x-EPS&&b.y>=a.y-EPS&&right(b)<=right(a)+EPS&&bottom(b)<=bottom(a)+EPS;}
function overlap(a:Rect,b:Rect){const w=Math.min(right(a),right(b))-Math.max(a.x,b.x),h=Math.min(bottom(a),bottom(b))-Math.max(a.y,b.y);return w>EPS&&h>EPS?w*h:0;}
function structuredItem(item:Line['items'][number],size:number){return item[0]==='M'||item[0]==='i'||item[0]==='u'||item[0]==='r'&&Number(item[3])>size&&Number(item[4])>size*2;}
function displayInfo(dl:DisplayList){
  const old=displayGeometry.get(dl),other=dl.other||EMPTY_ITEMS;
  if(old&&old.fonts===dl.fonts&&old.lines===dl.lines&&old.other===other&&old.lineCount===dl.lines.length&&old.otherCount===other.length){
    if(old.epoch===geometryEpoch)return old;
    if(Object.keys(dl.fonts).length===old.fontSnapshot.length&&old.fontSnapshot.every(font=>dl.fonts[font.key]?.size===font.size)){old.epoch=geometryEpoch;return old;}
  }
  let fontSize=655360;for(const font of Object.values(dl.fonts))fontSize=Math.max(fontSize,font.size||0);
  const next:DisplayGeometry={fonts:dl.fonts,lines:dl.lines,other,lineCount:dl.lines.length,otherCount:other.length,fontSize,otherStructured:other.some(item=>structuredItem(item,fontSize)),byLine:new WeakMap(),epoch:geometryEpoch,fontSnapshot:Object.entries(dl.fonts).map(([key,font])=>({key,size:font.size}))};
  displayGeometry.set(dl,next);return next;
}
function lineInfo(dl:DisplayList,line:Line){
  const display=displayInfo(dl),cached=display.byLine.get(line);
  if(cached&&cached.items===line.items&&cached.length===line.items.length&&cached.x===line.x&&cached.y===line.y&&cached.w===line.w&&cached.h===line.h&&cached.d===line.d)return cached;
  let drawn:Rect|null=null,structured=false;
  const add=(rect:Rect)=>{if(valid(rect)&&rect.w>0&&rect.h>0)drawn=drawn?union(drawn,rect):rect;};
  for(const item of line.items){
    structured=structured||structuredItem(item,display.fontSize);
    if(item[0]==='g'){
      const size=dl.fonts[String(item[1])]?.size||655360,x=Number(item[4]),y=Number(item[5]),w=Number(item[6]);
      add({x:Math.min(x,x+w),y:y-size*.8,w:Math.abs(w),h:size*1.05});
    }else if(item[0]==='r')add({x:Number(item[1]),y:Number(item[2]),w:Number(item[3]),h:Number(item[4])});
  }
  const shape={x:line.x,y:line.y-line.h,w:line.w,h:line.h+line.d};
  const rect=valid(shape)&&shape.w>0&&shape.h>0?(drawn?union(shape,drawn):shape):drawn;
  const next:LineGeometry={items:line.items,length:line.items.length,x:line.x,y:line.y,w:line.w,h:line.h,d:line.d,rect,structured};
  display.byLine.set(line,next);return next;
}
function ink(dl:DisplayList,line:Line,dx=0,dy=0):Rect|null {
  let result:Rect|null=null;
  const add=(r:Rect)=>{if(valid(r)&&r.w>0&&r.h>0)result=result?union(result,r):r;};
  for(const item of line.items){
    if(item[0]==='g'){
      const size=dl.fonts[String(item[1])]?.size||655360,x=Number(item[4])+dx,y=Number(item[5])+dy,w=Number(item[6]);
      add({x:Math.min(x,x+w),y:y-size*.8,w:Math.abs(w),h:size*1.05});
    }else if(item[0]==='r')add({x:Number(item[1])+dx,y:Number(item[2])+dy,w:Number(item[3]),h:Number(item[4])});
  }
  return result;
}
function bounds(dl:DisplayList,line:Line,dx=0,dy=0):Rect|null {
  const rect=lineInfo(dl,line).rect;if(!rect)return null;if(!dx&&!dy)return rect;
  const moved={x:rect.x+dx,y:rect.y+dy,w:rect.w,h:rect.h};if(valid(moved))return moved;
  // Preserve the original invalid-number behavior instead of trusting a translated
  // cached union when a malformed offset overflows an otherwise finite rectangle.
  const shape={x:line.x+dx,y:line.y+dy-line.h,w:line.w,h:line.h+line.d},drawn=ink(dl,line,dx,dy);
  return valid(shape)&&shape.w>0&&shape.h>0?(drawn?union(shape,drawn):shape):drawn;
}
function translated(overlay:Overlay,page:number):OverlayRow[]|null {
  const result:OverlayRow[]=[];
  for(const fragment of overlay.fragments){
    if(fragment.page!==page)continue;
    if(fragment.first_line<1||fragment.last_line<fragment.first_line||fragment.baselines.length!==fragment.last_line-fragment.first_line+1)return null;
    for(let i=0;i<fragment.baselines.length;i++){
      const line=overlay.dl.lines[fragment.first_line-1+i];if(!line)return null;
      const dx=(fragment.xs[i]??fragment.x)-line.x,dy=fragment.baselines[i]-line.y;
      if(!Number.isFinite(dx)||!Number.isFinite(dy))return null;
      result.push({line,dx,dy});
    }
  }
  return result;
}
export function hasStructuredInk(dl:DisplayList){
  geometryEpoch++;
  if(displayInfo(dl).otherStructured)return true;
  return dl.lines.some(line=>lineInfo(dl,line).structured);
}
/** Separate columns and discontinuous occupied regions, instead of treating a
 * multi-column capture unit's union box as one large safe editing rectangle. */
function slots(rows:Ink[]):Slot[]{
  const result:Slot[]=[];
  for(const row of [...rows].sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x)){
    const r=row.rect;
    const slot=result.find(slot=>{
      const xOverlap=Math.min(right(slot.rect),right(r))-Math.max(slot.rect.x,r.x);
      return xOverlap>Math.min(slot.rect.w,r.w)*.55&&r.y<=bottom(slot.rect)+Math.max(r.h,slot.rows.at(-1)!.rect.h)*2.2;
    });
    if(slot){slot.rect=union(slot.rect,r);slot.rows.push(row);}else result.push({rect:r,rows:[row]});
  }
  return result;
}
function sameAnchors(snapshot:AnchorSnapshot[]|null,placed:readonly Fragment[]|undefined,page:number){
  if(!placed)return snapshot===null;if(!snapshot)return false;
  let at=0;
  for(const fragment of placed){
    if(fragment.page!==page)continue;const saved=snapshot[at++];if(!saved||saved.x!==fragment.x||saved.approximate!==fragment.approximate||saved.xs.length!==fragment.xs.length||saved.baselines.length!==fragment.baselines.length)return false;
    for(let i=0;i<saved.baselines.length;i++)if(saved.baselines[i]!==fragment.baselines[i])return false;
    for(let i=0;i<saved.xs.length;i++)if(saved.xs[i]!==fragment.xs[i])return false;
  }
  return at===snapshot.length;
}
function originalGeometry(page:PageUpdate,pageNumber:number,parId:number,owned:ReadonlySet<number>,placed:readonly Fragment[]|undefined):OldGeometry|null{
  let cache=oldGeometry.get(page);if(!cache){cache=new Map();oldGeometry.set(page,cache);}const key=pageNumber+':'+parId,saved=cache.get(key);
  if(saved&&saved.indices.length===owned.size&&sameAnchors(saved.anchors,placed,pageNumber)&&saved.indices.every((index,i)=>owned.has(index)&&page.dl.lines[index]===saved.lines[i]&&lineInfo(page.dl,saved.lines[i])===saved.geometry[i]))return saved;
  const old:Ink[]=[],indices=[...owned],lines:Line[]=[],geometry:LineGeometry[]=[],anchors=placed?.filter(fragment=>fragment.page===pageNumber);
  for(const index of indices){
    const line=page.dl.lines[index];if(!line)return null;
    if(anchors&&!anchors.some(fragment=>fragment.baselines.some((baseline,i)=>Math.abs(line.y-baseline)<=ANCHOR_EPS&&Math.abs(line.x-(fragment.xs[i]??fragment.x))<=ANCHOR_EPS)))return null;
    const data=lineInfo(page.dl,line);lines.push(line);geometry.push(data);if(data.rect)old.push({page:pageNumber,rect:data.rect,baseline:line.y});
  }
  if(!old.length)return null;
  let internalOverlap=0;for(let i=0;i<old.length;i++)for(let j=0;j<i;j++)internalOverlap=Math.max(internalOverlap,overlap(old[i].rect,old[j].rect));
  const next:OldGeometry={indices,lines,geometry,anchors:anchors?.map(fragment=>({x:fragment.x,xs:fragment.xs.slice(),baselines:fragment.baselines.slice(),approximate:fragment.approximate}))||null,old,regions:slots(old),internalOverlap,overlapBaseline:new WeakMap()};
  cache.set(key,next);return next;
}
function newCollision(rect:Rect,other:Rect,original:OldGeometry){
  const area=overlap(rect,other);if(!area)return false;
  // Glyph font boxes can touch in deliberately tight original typography. Such
  // pre-existing overlap is not a regression introduced by the fast layer.
  let baseline=original.overlapBaseline.get(other);
  if(baseline===undefined){baseline=0;for(const row of original.old)baseline=Math.max(baseline,overlap(row.rect,other));original.overlapBaseline.set(other,baseline);}
  return area>baseline+EPS*EPS;
}

/** Safety gate before a paragraph display list replaces pixels of a full PDF.
 * It never reflows the page: changed geometry waits for authoritative pagination.
 * Shared images_info is deliberately ignored; only this unit's ink is inspected. */
export function overlaySafety(input:OverlaySafetyInput):OverlaySafety {
  const {overlay,pages,placements}=input,fail=(reason:OverlayUnsafeReason,page?:number):OverlaySafety=>({safe:false,reason,...(page===undefined?{}:{page})});
  if(input.structured||hasStructuredInk(overlay.dl))return fail('structured-content');
  if(overlay.fragments.some(fragment=>fragment.approximate))return fail('approximate-placement');
  if(!overlay.fragments.length||!overlay.dl.lines.length||placements&&!placements.get(overlay.parId)?.length)return fail('missing-placement');
  const seenLines=new Set<number>();
  for(const fragment of overlay.fragments)for(let i=fragment.first_line;i<=fragment.last_line;i++){if(seenLines.has(i))return fail('invalid-geometry',fragment.page);seenLines.add(i);}
  if(seenLines.size!==overlay.dl.lines.length)return fail('invalid-geometry');
  for(const pageNumber of new Set(overlay.fragments.map(fragment=>fragment.page))){
    const page=pages.get(pageNumber),owned=input.ownLines(pageNumber,overlay.parId);if(!page||!owned.size)return fail('missing-placement',pageNumber);
    const placed=placements?.get(overlay.parId)?.filter(fragment=>fragment.page===pageNumber);
    if(placed?.some(fragment=>fragment.approximate))return fail('approximate-placement',pageNumber);
    if(placements&&!placed?.length)return fail('missing-placement',pageNumber);
    const original=originalGeometry(page,pageNumber,overlay.parId,owned,placements?.get(overlay.parId));if(!original)return fail('missing-placement',pageNumber);const old=original.old;
    const rows=translated(overlay,pageNumber);if(!rows)return fail('invalid-geometry',pageNumber);
    const next:Ink[]=[];
    for(const row of rows){const rect=bounds(overlay.dl,row.line,row.dx,row.dy);if(!rect)return fail('invalid-geometry',pageNumber);next.push({page:pageNumber,rect,baseline:row.line.y+row.dy});}
    if(next.length>old.length)return fail('line-growth',pageNumber);
    const regions=original.regions,counts=new Map<Slot,number>();
    for(const row of next){
      const region=regions.find(slot=>contains(slot.rect,row.rect));if(!region)return fail('slot-overflow',pageNumber);
      const count=(counts.get(region)||0)+1;counts.set(region,count);if(count>region.rows.length)return fail('line-growth',pageNumber);
    }
    for(let i=0;i<next.length;i++)for(let j=0;j<i;j++)if(overlap(next[i].rect,next[j].rect)>original.internalOverlap+EPS*EPS)return fail('self-overlap',pageNumber);
    for(let i=0;i<page.dl.lines.length;i++){
      if(owned.has(i))continue;const other=bounds(page.dl,page.dl.lines[i]);if(other&&next.some(row=>newCollision(row.rect,other,original)))return fail('background-collision',pageNumber);
    }
    for(const other of input.otherOverlays||[]){
      if(other.parId===overlay.parId)continue;const otherRows=translated(other,pageNumber);if(!otherRows)continue;
      for(const row of otherRows){const rect=bounds(other.dl,row.line,row.dx,row.dy);if(rect&&next.some(candidate=>newCollision(candidate.rect,rect,original)))return fail('overlay-collision',pageNumber);}
    }
  }
  return {safe:true,reason:null};
}

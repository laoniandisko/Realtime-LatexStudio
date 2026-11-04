import type {Span} from './vendor/protocol';
import type {BlockTarget} from './block-edit';
import {canEditAsText} from './block-edit';
import {utf8ToOffset} from './mapping';

export interface SourceBinding {
  file: string; source: string; from: number; to: number;
  revision: number; lastRevision: number;
}

/** Convert a snapshot's UTF-8 endpoints together, rather than encoding and
 * decoding the entire source for every span. Invalid endpoints deliberately
 * remain absent: the original converter throws at the same span during install,
 * after any preceding valid bindings have already been recorded. */
function spanOffsets(source:string,spans:Span[]):Map<number,number>{
  const requested=new Set<number>();
  for(const span of spans)for(const offset of [span?.range?.start,span?.range?.end])if(Number.isInteger(offset)&&offset>=0)requested.add(offset);
  const offsets=new Map<number,number>(),leadingBom=source.charCodeAt(0)===0xfeff;
  let bytes=0,index=0;
  for(const endpoint of [...requested].sort((a,b)=>a-b)){
    while(bytes<endpoint&&index<source.length){
      const code=source.charCodeAt(index++);
      if(code<0x80)bytes++;
      else if(code<0x800)bytes+=2;
      else if(code>=0xd800&&code<=0xdbff&&source.charCodeAt(index)>=0xdc00&&source.charCodeAt(index)<=0xdfff){bytes+=4;index++;}
      else bytes+=3; // Includes isolated surrogates, encoded as U+FFFD.
    }
    // TextDecoder removes the first BOM; an empty prefix still has length zero.
    if(bytes===endpoint)offsets.set(endpoint,index-(leadingBom&&index>0?1:0));
  }
  return offsets;
}

/** Visual rows retain the source they were drawn from, even after another unit changes. */
export class SourceBindings {
  private units = new Map<number, SourceBinding[]>();
  clear() { this.units.clear(); }
  install(file: string, source: string, spans: Span[], revision: number) {
    if(!spans.length)return;
    const offsets=spanOffsets(source,spans);
    for (const span of spans) {
      const binding = {file, source, from:offsets.get(span.range.start)??utf8ToOffset(source,span.range.start), to:offsets.get(span.range.end)??utf8ToOffset(source,span.range.end), revision, lastRevision:span.last_revision};
      let history=this.units.get(span.id);if(!history)this.units.set(span.id,history=[]);
      const previous=history.at(-1);
      if(previous?.source===source&&previous.from===binding.from&&previous.to===binding.to)continue;
      history.push(binding);
      // Retain the initial layout as well as recent fast-path versions.
      if(history.length>24)history.splice(1,history.length-24);
    }
  }
  resolve(id:number, visualRevision:number):SourceBinding|null {
    const history=this.units.get(id);if(!history)return null;
    for(let i=history.length-1;i>=0;i--){const binding=history[i];if(binding.lastRevision<=visualRevision)return binding;}
    return null;
  }
}

/** Rebase exact ranges, allowing typing inside a block but rejecting crossed boundaries. */
export function rebaseTarget(target:BlockTarget, before:string, after:string):BlockTarget|null {
  if(before.slice(target.from,target.to)!==target.text)return null;
  if(before===after)return target;
  let start=0,oldEnd=before.length,newEnd=after.length;
  while(start<oldEnd&&start<newEnd&&before[start]===after[start])start++;
  while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
  const delta=newEnd-oldEnd;let from=target.from,to=target.to;
  if(oldEnd<=from && start<from){from+=delta;to+=delta;}
  else if(start>=to && (start!==to||oldEnd!==start)){}
  else if(start>=from&&oldEnd<=to){to+=delta;}
  else {
    // Several edits elsewhere can surround an untouched paragraph. Exact unique
    // text remains safe; never guess between duplicate paragraphs.
    const at=after.indexOf(target.text);
    if(!target.text||at<0||after.indexOf(target.text,at+1)>=0)return null;
    from=at;to=at+target.text.length;
  }
  if(from<0||to<from||to>after.length)return null;
  const text=after.slice(from,to);
  return {...target,from,to,text,mode:target.kind!=='formula'&&canEditAsText(text)?'text':'latex'};
}

import {charMap,glyphTextOf} from './vendor/glyphMap';
import type {TextRow} from './vendor/textLayer';
const cache=new WeakMap<readonly TextRow[],{source:string;gt:ReturnType<typeof glyphTextOf>;mapping:ReturnType<typeof charMap>}>();
export function unitMapping(rows:readonly TextRow[],source:string) {
  const previous=cache.get(rows);if(previous?.source===source)return previous;
  const gt=glyphTextOf(rows),result={source,gt,mapping:charMap(gt,source,0)};cache.set(rows,result);return result;
}

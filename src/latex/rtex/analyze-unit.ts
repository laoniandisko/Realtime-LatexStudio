import {paragraphRegions} from './paragraph-regions';
import {mathHits,type PageRow} from './math-hit';
import {pageCharacters} from './page-geometry';
import {objectRegions} from './object-edit';
export function analyzeUnit(rows:PageRow[],source:string) {
  const characters=pageCharacters(rows,source);
  return {paragraphs:paragraphRegions(rows,source),math:mathHits(rows,source),characters,objects:objectRegions(rows,source,characters)};
}
export type UnitAnalysis=ReturnType<typeof analyzeUnit>;

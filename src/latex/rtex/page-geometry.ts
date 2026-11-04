import { unitMapping } from './unit-mapping';
import type { PageRow } from './math-hit';

export interface PageCharacter { page: number; line?: number; x: number; y: number; w: number; h: number; from: number; to: number }
/** Runs in the existing mapping worker, never in an input event. Coordinates are in TeX sp. */
export function pageCharacters(rows: PageRow[], source: string): PageCharacter[] {
  const { gt, mapping: { at, vis } } = unitMapping(rows, source), result: PageCharacter[] = [];
  for (const glyph of gt.glyphs) {
    for (let i = 0; i < glyph.text.length; i++) {
      const index = at[glyph.start + i]; if (index < 0 || index === undefined) continue;
      result.push({ page: rows[glyph.row].page, line: glyph.row, x: glyph.x + glyph.adv * i / glyph.text.length,
        y: glyph.y - glyph.size * .8, w: glyph.adv / glyph.text.length, h: glyph.size,
        from: vis.start[index], to: vis.end[index] });
    }
  }
  return result;
}

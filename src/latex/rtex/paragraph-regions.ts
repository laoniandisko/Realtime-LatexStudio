import { unitMapping } from './unit-mapping';
import { words, type TextRow } from './vendor/textLayer';
import { mapPlainWord } from './mapping';
import { paragraphTarget, type BlockTarget } from './block-edit';

export interface Rect { x: number; y: number; w: number; h: number }
export interface Fragment<T> { key: string; page: number; rect: Rect; target: T; rows: number[] }

/** One rectangle per logical paragraph/column/page, never one rectangle per visual line. */
export function mergeParagraphRects<T>(fragments: Fragment<T>[]): Fragment<T>[] {
  const out: Fragment<T>[] = [];
  for (const f of [...fragments].sort((a, b) => a.page - b.page || a.rect.y - b.rect.y)) {
    const r = f.rect;
    const group = out.find(g => g.key === f.key && g.page === f.page && Math.min(g.rect.x + g.rect.w, r.x + r.w) - Math.max(g.rect.x, r.x) > Math.min(g.rect.w, r.w) * .2 && r.y <= g.rect.y + g.rect.h + Math.max(r.h * 2, 2));
    if (!group) { out.push({ ...f, rect: { ...r }, rows: [...f.rows] }); continue; }
    const right = Math.max(group.rect.x + group.rect.w, r.x + r.w), bottom = Math.max(group.rect.y + group.rect.h, r.y + r.h);
    group.rect.x = Math.min(group.rect.x, r.x); group.rect.y = Math.min(group.rect.y, r.y); group.rect.w = right - group.rect.x; group.rect.h = bottom - group.rect.y; group.rows.push(...f.rows);
  }
  return out;
}

export function paragraphRegions(rows: (TextRow & { page: number })[], source: string): Fragment<Omit<BlockTarget, 'file'>>[] {
  const {gt,mapping:alignment} = unitMapping(rows,source), fragments: Fragment<Omit<BlockTarget, 'file'>>[] = [];
  rows.forEach((row, index) => {
    for (const word of words([row])) {
      const glyph = gt.glyphs.find(g => g.row === index && Math.abs(g.x - word.x) < 32 && Math.abs(g.y - word.y) < 32);
      const mapped = glyph && mapPlainWord(gt, glyph.start, word.text, source, alignment); if (!mapped) continue;
      const target = paragraphTarget(source, mapped.from); if (!target || target.kind === 'formula') continue;
      fragments.push({ key: `${target.from}:${target.to}`, page: row.page, target, rows: [index], rect: { x: row.line.x + row.dx, y: row.line.y + row.dy - row.line.h, w: row.line.w, h: Math.max(row.line.h + row.line.d, 1) } }); break;
    }
  });
  return mergeParagraphRects(fragments);
}

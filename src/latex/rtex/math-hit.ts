import { unitMapping } from './unit-mapping';
import type { TextRow } from './vendor/textLayer';
import { mathRegions } from './block-edit';

export type PageRow = TextRow & { page: number };
export interface MathBox { page: number; x: number; y: number; w: number; h: number }
export interface MathHit { index: number; boxes: MathBox[] }
const mathFont = (name: string) => /(?:^cm(?:mi|mib|sy|ex)|^ms[ab]m|ntx(?:mi|sy|ex)|math|stmary|stix.*(?:symbol|integral))/i.test(name);

function rowBox(row: PageRow): MathBox {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const it of row.line.items) {
    if (it[0] === 'g') { const size = row.dl.fonts[String(it[1])]?.size || 655360, gx = Number(it[4]) + row.dx, gy = Number(it[5]) + row.dy; x = Math.min(x, gx); y = Math.min(y, gy - size); right = Math.max(right, gx + Number(it[6])); bottom = Math.max(bottom, gy + size * .3); }
    if (it[0] === 'r') { const gx = Number(it[1]) + row.dx, gy = Number(it[2]) + row.dy; x = Math.min(x, gx); y = Math.min(y, gy); right = Math.max(right, gx + Number(it[3])); bottom = Math.max(bottom, gy + Number(it[4])); }
  }
  return { page: row.page, x, y, w: right - x, h: bottom - y };
}

/** Conservative hit testing for rtex 0.0.6: pair only complete, unambiguous groups.
 * Ambiguous/custom math remains accessible through the paragraph's formula buttons. */
export function mathHits(rows: PageRow[], source: string): MathHit[] {
  const regions = mathRegions(source); if (!regions.length) return [];
  const displays = regions.map((region, index) => ({ region, index })).filter(r => r.region.display);
  const inline = regions.map((region, index) => ({ region, index })).filter(r => !r.region.display);
  const displayRows = new Set<number>();
  const {gt,mapping} = unitMapping(rows,source);
  rows.forEach((row, index) => {
    const glyphs = row.line.items.filter(it => it[0] === 'g');
    const mathCount = glyphs.filter(it => { const f = row.dl.fonts[String(it[1])]; return f && mathFont([f.name, f.fullname, f.filename].join(' ')); }).length;
    const assigned = gt.glyphs.filter(g => g.row === index && mapping.at[g.start] >= 0).map(g => mapping.vis.start[mapping.at[g.start]]);
    const sourceDisplay = displays.some(r => assigned.filter(at => at >= r.region.bodyFrom && at < r.region.bodyTo).length >= Math.max(2, assigned.length * .65));
    if (sourceDisplay || (glyphs.length > 0 && mathCount / glyphs.length > .36)) displayRows.add(index);
  });
  const groups: MathBox[][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!displayRows.has(i)) continue;
    const boxes: MathBox[] = [];
    do { const box = rowBox(rows[i]); if (Number.isFinite(box.x) && box.w > 0) boxes.push(box); i++; } while (displayRows.has(i));
    i--; if (boxes.length) groups.push(boxes);
  }
  const hits: MathHit[] = [];
  if (groups.length === displays.length) displays.forEach((r, index) => hits.push({ index: r.index, boxes: groups[index] }));
  const inlineGroups: MathBox[][] = []; let active: MathBox[] | null = null;
  rows.forEach((row, rowIndex) => {
    if (displayRows.has(rowIndex)) return;
    const size = Math.max(1, ...row.line.items.filter(it => it[0] === 'g').map(it => row.dl.fonts[String(it[1])]?.size || 655360));
    let box: MathBox | null = active ? { page: row.page, x: row.line.x + row.dx, y: row.line.y + row.dy - size, w: 0, h: size * 1.3 } : null;
    for (const item of row.line.items) {
      if (item[0] === 'm' && item[1] === 'on' && !active) { active = []; box = { page: row.page, x: Number(item[2]) + row.dx, y: row.line.y + row.dy - size, w: 0, h: size * 1.3 }; }
      else if (item[0] === 'm' && item[1] === 'off' && active && box) {
        box.w = Math.max(box.w, Number(item[2]) + row.dx - box.x);
        if (box.w > 0) active.push(box); if (active.length) inlineGroups.push(active); active = null; box = null;
      } else if (active && box && item[0] === 'g') {
        const fontSize = row.dl.fonts[String(item[1])]?.size || size, y = Number(item[5]) + row.dy, oldBottom = box.y + box.h;
        box.w = Math.max(box.w, Number(item[4]) + row.dx + Number(item[6]) - box.x); box.y = Math.min(box.y, y - fontSize); box.h = Math.max(oldBottom, y + fontSize * .3) - box.y;
      }
    }
    if (active && box) { box.w = Math.max(box.w, row.line.x + row.dx + row.line.w - box.x); if (box.w > 0) active.push(box); }
  });
  if (inlineGroups.length === inline.length) inline.forEach((r, index) => hits.push({ index: r.index, boxes: inlineGroups[index] }));
  return hits;
}

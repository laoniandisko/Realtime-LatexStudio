import { visibleSource } from './vendor/glyphMap';
import { mathRegions } from './block-edit';
import { escapeLatexText } from '../source-map';

export const OBJECT = '\ufffc';
export interface VisualChar { from: number; to: number; atom?: boolean }
export interface VisualText { text: string; chars: VisualChar[] }
function groupEnd(source: string, from: number, open = '{', close = '}') {
  if (source[from] !== open) return from;
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '%') { const end = source.indexOf('\n', i); if (end < 0) return source.length; i = end; continue; }
    if (source[i] === open) depth++;
    if (source[i] === close && --depth === 0) return i + 1;
  }
  return source.length;
}

/** The keyboard edits visible prose; TeX commands and braces never enter the input buffer.
 * Math and generated references are indivisible objects, preserving their complete source. */
export function visualText(source: string): VisualText {
  const atoms: VisualChar[] = mathRegions(source).map(r => ({ from: r.from, to: r.to, atom: true }));
  for (const match of source.matchAll(/\\(?:cite[a-zA-Z]*|[Cc]ref|[Cc]refrange|eqref|ref|pageref|autoref|nameref|footnote)\*?\s*/g)) {
    const from = match.index!;
    if (atoms.some(a => a.from <= from && from < a.to)) continue;
    let to = from + match[0].length;
    while (source[to] === '[') to = groupEnd(source, to, '[', ']');
    if (source[to] !== '{') continue;
    to = groupEnd(source, to);
    if (/range/.test(match[0]) && source[to] === '{') to = groupEnd(source, to);
    atoms.push({ from, to, atom: true });
  }
  atoms.sort((a, b) => a.from - b.from || b.to - a.to);
  const outer = atoms.filter((a, i) => !atoms.slice(0, i).some(b => b.to > a.from));
  const chars: VisualChar[] = []; let text = '', cursor = 0;
  const segment = (from: number, to: number) => {
    // A sentinel retains leading spaces after a generated reference/formula. Aligning
    // the whole source first would collapse the two spaces on either side of a macro.
    const visible = visibleSource('X' + source.slice(from, to));
    for (let i = 1; i < visible.text.length; i++) {
      const start = from + visible.start[i] - 1; let end = from + visible.end[i] - 1;
      if (/\s/.test(visible.text[i])) while (end < to && /\s/.test(source[end])) end++;
      text += visible.text[i]; chars.push({ from: start, to: end });
    }
  };
  for (const atom of outer) { segment(cursor, atom.from); text += OBJECT; chars.push(atom); cursor = atom.to; }
  segment(cursor, source.length);
  return { text, chars };
}

export function visualOffset(projection: VisualText, sourceOffset: number, after = false) {
  let left = 0, right = projection.chars.length;
  while (left < right) { const mid = (left + right) >>> 1; if (projection.chars[mid].to <= sourceOffset) left = mid + 1; else right = mid; }
  const ch = projection.chars[left];
  return ch && sourceOffset >= ch.from && after ? left + 1 : left;
}

export function visualSourceOffset(source: string, projection: VisualText, index: number, end = false) {
  const previous=projection.chars[index-1],next=projection.chars[index];
  if(previous&&(end||!next||/^\}+$/.test(source.slice(previous.to,next.from))))return previous.to;
  return next?.from??previous?.to??source.length;
}

/** Delete only selected printed characters, keeping intervening formatting wrappers intact. */
export function replaceVisual(source: string, from: number, to: number, inserted: string) {
  const p = visualText(source);
  from = Math.max(0, Math.min(from, p.text.length)); to = Math.max(from, Math.min(to, p.text.length));
  const at = from===to?visualSourceOffset(source,p,from):p.chars[from]?.from??source.length;
  const ranges: VisualChar[] = [];
  for (const ch of p.chars.slice(from, to)) {
    const last = ranges.at(-1);
    if (last && ch.from <= last.to) last.to = Math.max(last.to, ch.to);
    else ranges.push({ ...ch });
  }
  const value = escapeLatexText(inserted.replaceAll(OBJECT, '').replace(/\r\n?/g, '\n'));
  let next = source;
  for (const range of ranges.reverse()) next = next.slice(0, range.from) + next.slice(range.to);
  return next.slice(0, at) + value + next.slice(at);
}

export function textChange(before: string, after: string) {
  let from = 0, to = before.length, end = after.length;
  while (from < to && from < end && before[from] === after[from]) from++;
  while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
  return { from, to, inserted: after.slice(from, end) };
}

/** Native selection disambiguates repeated letters across different formatting runs. */
export function changeAtSelection(before: string, after: string, start: number, end: number, type = '') {
  const delta = after.length - before.length;
  let from = start, to = end;
  if (start === end && delta < 0) {
    if (/Backward$/.test(type)) from = Math.max(0, start + delta);
    else if (/Forward$/.test(type)) to = Math.min(before.length, end - delta);
    else return textChange(before, after);
  }
  const insertedEnd = to + delta;
  if (insertedEnd >= from && before.slice(0, from) === after.slice(0, from) && before.slice(to) === after.slice(insertedEnd)) return { from, to, inserted: after.slice(from, insertedEnd) };
  return textChange(before, after);
}

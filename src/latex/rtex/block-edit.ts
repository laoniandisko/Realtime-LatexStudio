import { escapeLatexText } from '../source-map';

export interface MathRegion {
  from: number; to: number; bodyFrom: number; bodyTo: number;
  display: boolean; environment: string;
}
export interface BlockTarget {
  file: string; from: number; to: number; text: string;
  kind: 'paragraph' | 'formula' | 'heading' | 'source';
  mode: 'text' | 'latex'; label: string;
}
const mathEnvironment = /^(?:equation|align|alignat|gather|multline|flalign|displaymath|math|eqnarray)\*?$/;
const literalEnvironment = /^(?:verbatim|Verbatim|lstlisting|minted)$/;
const skipComment = (source: string, i: number) => { const n = source.indexOf('\n', i); return n < 0 ? source.length : n; };

function groupEnd(source: string, start: number, open = '{', close = '}'): number {
  if (source[start] !== open) return start;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '%') { i = skipComment(source, i); continue; }
    if (source[i] === open) depth++;
    if (source[i] === close && --depth === 0) return i + 1;
  }
  return start;
}

/** Source ranges retain the original math delimiters, environment, labels and numbering. */
export function mathRegions(source: string): MathRegion[] {
  const out: MathRegion[] = [];
  for (let i = 0; i < source.length;) {
    if (source[i] === '%') { i = skipComment(source, i); continue; }
    const verb = /^\\verb\*?(.)/.exec(source.slice(i));
    if (verb) { const end = source.indexOf(verb[1], i + verb[0].length); i = end < 0 ? source.length : end + 1; continue; }
    const begin = /^\\begin\{([^}]+)\}/.exec(source.slice(i));
    if (begin && literalEnvironment.test(begin[1])) { const end = source.indexOf(`\\end{${begin[1]}}`, i + begin[0].length); i = end < 0 ? source.length : end + begin[1].length + 6; continue; }
    if (begin && mathEnvironment.test(begin[1])) {
      let bodyFrom = i + begin[0].length;
      if (source[bodyFrom] === '[') bodyFrom = groupEnd(source, bodyFrom, '[', ']') || bodyFrom;
      if (/^alignat/.test(begin[1]) && source[bodyFrom] === '{') bodyFrom = groupEnd(source, bodyFrom) || bodyFrom;
      let depth = 1, end = -1, endTo = -1;
      for (let k = bodyFrom; k < source.length;) {
        if (source[k] === '%') { k = skipComment(source, k); continue; }
        const tag = /^\\(begin|end)\{([^}]+)\}/.exec(source.slice(k));
        if (tag) { if (tag[2] === begin[1]) depth += tag[1] === 'begin' ? 1 : -1; if (!depth) { end = k; endTo = k + tag[0].length; break; } k += tag[0].length; }
        else k += source[k] === '\\' ? 2 : 1;
      }
      if (end >= 0) { out.push({ from: i, to: endTo, bodyFrom, bodyTo: end, display: begin[1] !== 'math', environment: begin[1] }); i = endTo; continue; }
    }
    if (source.startsWith('\\ensuremath{', i)) {
      const start = i + 11, end = groupEnd(source, start);
      if (end > start) { out.push({ from: i, to: end, bodyFrom: start + 1, bodyTo: end - 1, display: false, environment: 'ensuremath' }); i = end; continue; }
    }
    const opening = source.startsWith('$$', i) ? '$$' : source[i] === '$' ? '$' : source.startsWith('\\(', i) ? '\\(' : source.startsWith('\\[', i) ? '\\[' : '';
    if (opening) {
      const closing = opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening;
      let end = -1;
      for (let k = i + opening.length; k < source.length;) {
        if (source[k] === '%') { k = skipComment(source, k); continue; }
        if (source.startsWith(closing, k)) { end = k; break; }
        k += source[k] === '\\' ? 2 : 1;
      }
      if (end >= 0) { out.push({ from: i, to: end + closing.length, bodyFrom: i + opening.length, bodyTo: end, display: opening === '$$' || opening === '\\[', environment: opening }); i = end + closing.length; continue; }
    }
    i += source[i] === '\\' ? 2 : 1;
  }
  return out;
}

export const canEditAsText = (source: string) => !/[\\{}$%&#_^~]/.test(source);
export const blockInput = (mode: 'text' | 'latex', value: string) => mode === 'text' ? escapeLatexText(value) : value;

function target(source: string, from: number, to: number, kind: BlockTarget['kind'], label: string): Omit<BlockTarget, 'file'> | null {
  while (from < to && /\s/.test(source[from])) from++;
  while (to > from && /\s/.test(source[to - 1])) to--;
  if (from >= to) return null;
  const text = source.slice(from, to);
  return { from, to, text, kind, label, mode: kind !== 'formula' && canEditAsText(text) ? 'text' : 'latex' };
}
export function formulaTarget(source: string, region: MathRegion): Omit<BlockTarget, 'file'> | null {
  let from = region.bodyFrom, to = region.bodyTo;
  // Labels/tags normally sit at either edge. Keep those outside the editable expression.
  while (from < to) {
    const leading = /^\s*\\(?:label|tag\*?)\s*/.exec(source.slice(from, to));
    if (!leading) break;
    const end = groupEnd(source, from + leading[0].length); if (end <= from + leading[0].length) break; from = end;
  }
  while (to > from) {
    const tags = [...source.slice(from, to).matchAll(/\\(?:label|tag\*?)\s*\{/g)];
    const last = tags.at(-1); if (!last) break;
    const at = from + last.index!, end = groupEnd(source, at + last[0].length - 1);
    if (!end || source.slice(end, to).trim()) break; to = at;
  }
  // Empty formula bodies must still be editable (e.g. immediately after insertion).
  return target(source, from, to, 'formula', region.display ? `行间公式 · ${region.environment}` : '行内公式') || { from, to, text: '', kind: 'formula', mode: 'latex', label: region.display ? '行间公式' : '行内公式' };
}

/** Select the whole prose paragraph around a source position, preserving enclosing markup. */
export function paragraphTarget(source: string, offset: number): Omit<BlockTarget, 'file'> | null {
  const math = mathRegions(source);
  const formula = math.find(r => r.from <= offset && offset < r.to);
  if (formula) return formulaTarget(source, formula);
  const headings: { from: number; to: number }[] = [];
  for (const heading of source.matchAll(/\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\s*/g)) {
    const open = heading.index! + heading[0].length, end = groupEnd(source, open);
    if (end <= open) continue;
    if (offset >= heading.index! && offset < end) return target(source, open + 1, end - 1, 'heading', '标题');
    headings.push({ from: heading.index!, to: end });
  }
  // Structured blocks have an explicit source editor; never flatten their commands into text.
  for (const begin of source.matchAll(/\\begin\{(tabular\*?|tabularx|array|figure\*?|table\*?|tikzpicture|verbatim|lstlisting|minted)\}/g)) {
    const endToken = `\\end{${begin[1]}}`, end = source.indexOf(endToken, begin.index! + begin[0].length);
    if (end >= 0 && begin.index! <= offset && offset < end + endToken.length) return target(source, begin.index!, end + endToken.length, 'source', '结构块 · LaTeX');
  }
  const barriers: { from: number; to: number }[] = [...math.filter(r => r.display), ...headings];
  for (const match of source.matchAll(/\n[\t \r]*\n+|\\(?:begin|end)\{[^}]+\}|\\item(?:\[[^\]]*\])?[\t ]*|\\par\b/g)) barriers.push({ from: match.index!, to: match.index! + match[0].length });
  let from = 0, to = source.length;
  for (const b of barriers) { if (b.to <= offset) from = Math.max(from, b.to); if (b.from > offset) to = Math.min(to, b.from); }
  return target(source, from, to, 'paragraph', '整段编辑');
}

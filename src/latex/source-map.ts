export interface SourceFile { name: string; content: string }
export interface Mapping { file: string; from: number; to: number; text: string; line: number }
export const normalizeText = (s: string) => s.normalize('NFKC').replace(/[\u2010-\u2014]/g, '-').replace(/\s+/g, ' ').trim();

// Keep page edits out of math and literal-code environments even when a word
// inside them happens to match the visible glyphs exactly.
export function isTextPosition(source: string, offset: number): boolean {
  let math = '', environment = '';
  const protectedEnvironment = /^(?:equation|align|alignat|gather|multline|flalign|math|displaymath|verbatim|Verbatim|lstlisting|minted)\*?$/;
  for (let i = 0; i <= offset && i < source.length; i++) {
    if (source[i] === '%') { const end = source.indexOf('\n', i); if (end < 0 || offset < end) return false; i = end; continue; }
    if (source[i] === '\\') {
      const token = /^\\(?:begin|end)\{([^}]+)\}/.exec(source.slice(i));
      if (token) { if (protectedEnvironment.test(token[1])) environment = token[0].startsWith('\\begin') ? token[1] : ''; i += token[0].length - 1; continue; }
      const next = source[i + 1];
      if (next === '(' || next === '[') math = next;
      else if (next === ')' || next === ']') math = '';
      else if (/[A-Za-z]/.test(next || '')) {
        const command = /^\\[A-Za-z]+/.exec(source.slice(i))![0];
        if (offset < i + command.length) return false;
        if (command === '\\verb' || command === '\\verb*') {
          const at = i + command.length + (source[i + command.length] === '*' ? 1 : 0), end = source.indexOf(source[at], at + 1);
          if (end < 0 || offset <= end) return false; i = end; continue;
        }
        i += command.length - 1; continue;
      }
      i++; continue;
    } else if (source[i] === '$') {
      const delimiter = source[i + 1] === '$' ? '$$' : '$'; math = math ? '' : delimiter; if (delimiter === '$$') i++;
    }
  }
  return !math && !environment;
}

// Map normalized text back to original character offsets. Commands, math and
// comments are boundaries: a PDF edit must never eat TeX structure.
export function mapPdfText(text: string, files: SourceFile[], hint?: { file: string; line: number }): Mapping[] {
  const target = normalizeText(text);
  if (!target || target.length < 2) return [];
  const matches: Mapping[] = [];
  for (const file of files.filter(f => f.name.endsWith('.tex'))) {
    const src = file.content;
    let normalized = '', offsets: number[] = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '%' && (i === 0 || src[i - 1] !== '\\')) {
        while (i < src.length && src[i] !== '\n') i++;
        normalized += '\0'; offsets.push(i); continue;
      }
      if ('\\{}$'.includes(c)) { normalized += '\0'; offsets.push(i); continue; }
      const chars = /\s/.test(c) ? ' ' : c.normalize('NFKC').replace(/[\u2010-\u2014]/g, '-');
      if (chars === ' ' && normalized.endsWith(' ')) continue;
      for (const ch of chars) { normalized += ch; offsets.push(i); }
    }
    let pos = normalized.indexOf(target);
    while (pos !== -1) {
      const from = offsets[pos], to = offsets[pos + target.length - 1] + 1;
      // Control sequences partially matching rendered words are not plain text.
      const commandStart = src.slice(0, from).match(/\\[A-Za-z]*$/);
      if (!commandStart && isTextPosition(src, from) && !/[\\{}$%]/.test(src.slice(from, to))) {
        matches.push({ file: file.name, from, to, text: src.slice(from, to), line: src.slice(0, from).split('\n').length });
      }
      pos = normalized.indexOf(target, pos + 1);
    }
  }
  if (hint) matches.sort((a, b) => {
    const score = (m: Mapping) => (m.file.replace(/\\/g, '/') === hint.file.replace(/\\/g, '/') ? 0 : 100000) + Math.abs(m.line - hint.line);
    return score(a) - score(b);
  });
  return matches;
}

export function escapeLatexText(s: string): string {
  const escaped: Record<string, string> = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return s.replace(/[\\&%$#_{}~^]/g, c => escaped[c]);
}

export function applyMappedEdit(file: SourceFile, mapping: Mapping, replacement: string): string {
  if (file.name !== mapping.file || file.content.slice(mapping.from, mapping.to) !== mapping.text) throw new Error('源码已变化，请重新编译后再编辑 PDF。');
  return file.content.slice(0, mapping.from) + escapeLatexText(replacement) + file.content.slice(mapping.to);
}

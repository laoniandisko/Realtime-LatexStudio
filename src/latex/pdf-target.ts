import { mapPdfText, type SourceFile } from './source-map';
import { mathRegions, formulaTarget, paragraphTarget, type BlockTarget } from './rtex/block-edit';

export function pdfEditTargets(text: string, files: SourceFile[], hint?: { file: string; line: number }): BlockTarget[] {
  const matches = mapPdfText(text, files, hint).filter(m => !hint || (m.file === hint.file && Math.abs(m.line - hint.line) <= 2));
  const targets: BlockTarget[] = [];
  for (const m of matches) { const f = files.find(f => f.name === m.file)!; const t = paragraphTarget(f.content, m.from); if (t && !targets.some(x => x.file === m.file && x.from === t.from && x.to === t.to)) targets.push({ ...t, file: m.file }); }
  if (targets.length || !hint) return targets;
  const f = files.find(f => f.name === hint.file); if (!f) return [];
  const lines = f.content.split('\n'); if (hint.line < 1 || hint.line > lines.length) return [];
  const offset = lines.slice(0, hint.line - 1).reduce((n, line) => n + line.length + 1, 0);
  const math = mathRegions(f.content).filter(r => {
    const startLine = f.content.slice(0, r.from).split('\n').length, endLine = f.content.slice(0, r.to).split('\n').length;
    return hint.line >= startLine && hint.line <= endLine;
  });
  if (math.length) return math.map(r => ({ ...formulaTarget(f.content, r)!, file: f.name }));
  // Non-text output is still editable as its surrounding source block. Never silently navigate away.
  if (/^\s*\\end\{document\}/.test(lines[hint.line - 1])) return [];
  let cursor = offset + (lines[hint.line - 1].match(/^\s*/)?.[0].length || 0);
  if (/^\\end\{/.test(f.content.slice(cursor))) cursor = Math.max(0, cursor - 2);
  const target = paragraphTarget(f.content, cursor);
  return target ? [{ ...target, file: f.name }] : [];
}

import { sourceOffset, type GlyphText, type charMap } from './vendor/glyphMap';
import { normalizeText, isTextPosition } from '../source-map';

export function utf8ToOffset(text: string, offset: number): number {
  const data = new TextEncoder().encode(text);
  if (!Number.isInteger(offset) || offset < 0 || offset > data.length) throw Error('Invalid UTF-8 offset');
  return new TextDecoder('utf-8', { fatal: true }).decode(data.slice(0, offset)).length;
}
export function mapPlainWord(gt: GlyphText, glyphStart: number, rendered: string, source: string, alignment?: ReturnType<typeof charMap>): { from: number; to: number; text: string } | null {
  const length = rendered.trimEnd().length;
  if (!length) return null;
  const from = alignment ? alignment.at[glyphStart] >= 0 ? alignment.vis.start[alignment.at[glyphStart]] : undefined : sourceOffset(gt, glyphStart, false, source);
  const to = alignment ? alignment.at[glyphStart + length - 1] >= 0 ? alignment.vis.end[alignment.at[glyphStart + length - 1]] : undefined : sourceOffset(gt, glyphStart + length - 1, true, source);
  if (from === undefined || to === undefined || to <= from) return null;
  const text = source.slice(from, to);
  if (!isTextPosition(source, from) || /[\\{}$%]/.test(text) || normalizeText(text) !== normalizeText(rendered)) return null;
  return { from, to, text };
}

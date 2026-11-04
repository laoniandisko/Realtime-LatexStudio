import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPdfText, applyMappedEdit, escapeLatexText } from '../../src/latex/source-map.ts';

test('PDF text with wrapped whitespace maps to an exact source range', () => {
  const file = { name: 'main.tex', content: '\\section{Introduction}\nExample document\nrepresentations enable reconstruction.' };
  const [m] = mapPdfText('Example document representations', [file]);
  assert.equal(m.text, 'Example document\nrepresentations');
  assert.equal(applyMappedEdit(file, m, 'Coherent representations'), '\\section{Introduction}\nCoherent representations enable reconstruction.');
});
test('duplicate occurrences remain explicit and SyncTeX sorts nearby matches', () => {
  const file = { name: 'main.tex', content: 'Repeated sentence.\n\n\nRepeated sentence.' };
  const matches = mapPdfText('Repeated sentence.', [file], { file: 'main.tex', line: 4 });
  assert.equal(matches.length, 2); assert.equal(matches[0].line, 4);
});
test('PDF edits do not cross TeX commands, math or comments', () => {
  const f = { name: 'main.tex', content: '\\textbf{Example} document\n% Private comment\n$x+y$' };
  assert.equal(mapPdfText('Example document', [f]).length, 0);
  assert.equal(mapPdfText('Private comment', [f]).length, 0);
  assert.equal(mapPdfText('textbf', [f]).length, 0);
});
test('edited text escapes TeX control characters and stale mappings are rejected', () => {
  assert.equal(escapeLatexText('50% & $5_0'), '50\\% \\& \\$5\\_0');
  const [m] = mapPdfText('Some text', [{ name: 'main.tex', content: 'Some text.' }]);
  assert.throws(() => applyMappedEdit({ name: 'main.tex', content: 'Changed text.' }, m, 'New'), /源码已变化/);
});
test('PDF ligatures normalize to the original source characters', () => {
  const [m] = mapPdfText('efﬁcient reconstruction', [{ name: 'main.tex', content: 'An efficient reconstruction method.' }]);
  assert.equal(m.text, 'efficient reconstruction');
});

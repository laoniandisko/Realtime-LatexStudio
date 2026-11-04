import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { documentEdit } from './document-edit.mjs';
const bundled = await build({ stdin: { contents: "export { utf8ToOffset, mapPlainWord } from './src/latex/rtex/mapping.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022' });
const { utf8ToOffset, mapPlainWord } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const glyphs = text => ({ text, glyphs: [] });

test('live preview maps duplicate words to their own source occurrence', () => {
  const source = 'A dynamic world needs dynamic geometry.';
  const mapped = mapPlainWord(glyphs(source), source.lastIndexOf('dynamic'), 'dynamic', source);
  assert.deepEqual(mapped, { from: 22, to: 29, text: 'dynamic' });
});
test('editing formatted text changes only text inside the formatting command', () => {
  const source = 'A \\textbf{dynamic} world.';
  const mapped = mapPlainWord(glyphs('A dynamic world.'), 2, 'dynamic', source);
  assert.equal(mapped.text, 'dynamic');
  assert.equal(source.slice(0, mapped.from) + 'coherent' + source.slice(mapped.to), 'A \\textbf{coherent} world.');
});
test('macro-produced reference numbers are not editable source text', () => {
  const source = 'See Figure \\ref{fig:one}.';
  assert.equal(mapPlainWord(glyphs('See Figure 1.'), 11, '1', source), null);
});
test('escaped TeX characters are not replaced as structural source fragments', () => {
  assert.equal(mapPlainWord(glyphs('A & B'), 2, '&', 'A \\& B'), null);
});
test('UTF-8 engine ranges map correctly to Monaco UTF-16 positions', () => {
  const text = '你好A😀';
  assert.equal(utf8ToOffset(text, 6), 2); assert.equal(utf8ToOffset(text, 7), 3); assert.equal(utf8ToOffset(text, 11), 5);
  assert.throws(() => utf8ToOffset(text, 1));
});

test('math and literal code words stay in source editing mode', () => {
  for (const source of ['Before $energy$ after', 'Before \\(energy\\) after', '\\begin{align}energy\\end{align}', '\\begin{verbatim}energy\\end{verbatim}', '\\verb|energy|']) {
    assert.equal(mapPlainWord(glyphs('Before energy after'), 7, 'energy', source), null, source);
  }
});

test('minimal live edits preserve preambles and Unicode byte boundaries', () => {
  for (const [before, after] of [['\\documentclass{article}\nExample scenes', '\\documentclass{article}\nPortable scenes'], ['前😀后', '前😁后'], ['前𐀀后', '前𐐀后'], ['end', 'end😀'], ['😀end', 'end'], ['unchanged', 'unchanged']]) {
    const edit = documentEdit(before, after);
    if (!edit) { assert.equal(before, after); continue; }
    const bytes = Buffer.from(before); const strict = new TextDecoder('utf8', { fatal: true });
    assert.equal(strict.decode(bytes.subarray(0, edit.start)) + edit.text + strict.decode(bytes.subarray(edit.end)), after);
    if (before.includes('Example')) assert.equal(edit.start, Buffer.byteLength('\\documentclass{article}\n'));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({ stdin: { contents: "export * from './src/latex/rtex/block-edit'; export { mathHits } from './src/latex/rtex/math-hit'; export { mergeParagraphRects, paragraphRegions } from './src/latex/rtex/paragraph-regions'; export { pdfEditTargets } from './src/latex/pdf-target';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { mathRegions, formulaTarget, paragraphTarget, blockInput, mathHits, mergeParagraphRects, paragraphRegions, pdfEditTargets } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const replace = (source, target, value) => source.slice(0, target.from) + blockInput(target.mode, value) + source.slice(target.to);

test('whole abstract edits preserve its environment and adjacent source', () => {
  const source = '\\begin{abstract}\nA coherent world. Another sentence.\n\\end{abstract}\n';
  const target = paragraphTarget(source, source.indexOf('Another'));
  assert.equal(target.text, 'A coherent world. Another sentence.'); assert.equal(target.mode, 'text');
  assert.equal(replace(source, target, 'A new paragraph.\nIt has 50% detail & context.'), '\\begin{abstract}\nA new paragraph.\nIt has 50\\% detail \\& context.\n\\end{abstract}\n');
});
test('a paragraph beside a display formula never swallows the equation', () => {
  const source = 'Before the formula.\n\\begin{equation}x^2+y^2\\end{equation}\nAfter the formula. More text.';
  assert.equal(paragraphTarget(source, 2).text, 'Before the formula.');
  const after = paragraphTarget(source, source.indexOf('More'));
  assert.equal(after.text, 'After the formula. More text.');
  assert(replace(source, after, 'Revised text.').includes('\\begin{equation}x^2+y^2\\end{equation}'));
});
test('formatted paragraphs use lossless LaTeX rather than flattening markup', () => {
  const source = 'A \\textbf{coherent} world with $x^2$ and \\cite{key}.';
  const target = paragraphTarget(source, source.indexOf('world'));
  assert.equal(target.mode, 'latex'); assert.equal(target.text, source);
  assert.equal(replace(source, target, target.text.replace('world', 'scene')), 'A \\textbf{coherent} scene with $x^2$ and \\cite{key}.');
});
test('math range lexer handles delimiters, nested environments, comments and code', () => {
  const source = String.raw`Cost \$5. % $ignored$
\verb|$not_math$| \begin{verbatim}$also_not$\end{verbatim}
$x_1$ \(\alpha+\beta\) $$x^2$$ \[\frac{a}{b}\]
\begin{alignat}{2}a&=b\\c&=d\end{alignat}
\ensuremath{\frac{x}{y}}`;
  const regions = mathRegions(source);
  assert.equal(regions.length, 6); assert.deepEqual(regions.map(r => r.display), [false, false, true, true, true, false]);
  assert.equal(source.slice(regions[4].bodyFrom, regions[4].bodyTo), 'a&=b\\\\c&=d');
  assert.equal(source.slice(regions[5].bodyFrom, regions[5].bodyTo), '\\frac{x}{y}');
  assert.equal(mathRegions('An incomplete $x+').length, 0);
});
test('formula edits retain delimiters, equation labels and explicit numbering', () => {
  const source = '\\begin{equation}\\label{eq:one}\n  E=mc^2\n\\tag{A}\\end{equation}';
  const target = formulaTarget(source, mathRegions(source)[0]);
  assert.equal(target.text, 'E=mc^2'); assert.equal(target.mode, 'latex');
  assert.equal(replace(source, target, '\\frac{a+b}{c}'), '\\begin{equation}\\label{eq:one}\n  \\frac{a+b}{c}\n\\tag{A}\\end{equation}');
  const inline = 'A $x_1$ example.'; const t = formulaTarget(inline, mathRegions(inline)[0]);
  assert.equal(replace(inline, t, '\\sqrt{x}'), 'A $\\sqrt{x}$ example.');
});
test('heading text edits retain command, star and short title', () => {
  const source = '\\section*[Short]{A long title}\n';
  const target = paragraphTarget(source, source.indexOf('long'));
  assert.equal(target.text, 'A long title'); assert.equal(target.kind, 'heading');
  assert.equal(replace(source, target, 'A revised title'), '\\section*[Short]{A revised title}\n');
  const document = '\\begin{document}\n\\section{Keep this heading}\nA new paragraph.\n\\end{document}';
  const prose = paragraphTarget(document, document.indexOf('A new'));
  assert.equal(prose.text, 'A new paragraph.');
  assert(replace(document, prose, 'Revised.').includes('\\section{Keep this heading}'));
});
test('multiple paragraphs and structured blocks remain separate source targets', () => {
  const source = 'First paragraph.\n\nSecond paragraph.';
  assert.equal(paragraphTarget(source, source.indexOf('Second')).text, 'Second paragraph.');
  const table = '\\begin{tabular}{ll}A & B\\\\ C & D\\end{tabular}';
  assert.equal(paragraphTarget(table, table.indexOf('A')).kind, 'source');
});
test('inline formula hits pair exact math boundaries and reject ambiguous macro expansion', () => {
  const dl = { fonts: { 1: { size: 10, name: 'regular' }, 2: { size: 10, name: 'cmmi10' } } };
  const row = { page: 1, dl, dx: 0, dy: 0, line: { x: 0, y: 10, w: 30, h: 8, d: 2, items: [['g', 1, 65, 1, 0, 10, 5], ['m', 'on', 6], ['g', 2, 120, 1, 6, 10, 5], ['m', 'off', 11], ['g', 1, 66, 1, 12, 10, 5]] } };
  const hits = mathHits([row], 'A $x$ B'); assert.equal(hits.length, 1); assert.equal(hits[0].index, 0); assert.equal(hits[0].boxes[0].x, 6);
  assert.deepEqual(mathHits([row], 'A $x$ and $y$ B'), []);
});

test('four visual lines are one logical paragraph and one highlight rectangle', () => {
  const source = '\\begin{abstract}\nAlpha Bravo Charlie Delta\n\\end{abstract}';
  const dl = { fonts: { 1: { size: 10, name: 'regular' } } };
  const rows = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((text, index) => ({ page: 1, dl, dx: 0, dy: 0, line: { x: 10, y: 15 + index * 15, w: 100, h: 10, d: 3, items: Array.from(text, (c, i) => ['g', 1, c.codePointAt(0), 1, 10 + i * 6, 15 + index * 15, 6]) } }));
  const fragments = paragraphRegions(rows, source);
  assert.equal(fragments.length, 1); assert.equal(fragments[0].rows.length, 4);
  assert.equal(fragments[0].target.text, 'Alpha Bravo Charlie Delta'); assert.equal(fragments[0].rect.h, 58);
});
test('paragraph rectangles keep columns, pages and separate paragraphs apart', () => {
  const f = (key, page, x, y) => ({ key, page, rect: { x, y, w: 100, h: 10 }, rows: [], target: key });
  assert.equal(mergeParagraphRects([f('a', 1, 0, 0), f('a', 1, 0, 15), f('a', 1, 130, 0), f('a', 2, 0, 0), f('b', 1, 0, 30)]).length, 4);
});
test('the full-PDF route expands a wrapped text line to its whole paragraph', () => {
  const content = '\\begin{document}\n\\begin{abstract}\nAlpha sentence. Bravo sentence. Charlie sentence. Delta sentence.\n\\end{abstract}\n\\begin{tabular}{ll}A&B\\end{tabular}\n\\end{document}';
  const targets = pdfEditTargets('Bravo sentence. Charlie sentence.', [{ name: 'main.tex', content }], { file: 'main.tex', line: 3 });
  assert.equal(targets.length, 1); assert.equal(targets[0].kind, 'paragraph');
  assert.equal(targets[0].text, 'Alpha sentence. Bravo sentence. Charlie sentence. Delta sentence.');
});
test('the full-PDF route opens display math and explicitly chooses ambiguous inline formulas', () => {
  const content = '\\begin{document}\nA $x^2$ and \\(\\alpha+\\beta\\).\n\\begin{equation}\\label{eq:a}\nE=mc^2\n\\end{equation}\n\\end{document}';
  const files = [{ name: 'main.tex', content }];
  const display = pdfEditTargets('E', files, { file: 'main.tex', line: 4 });
  assert.equal(display.length, 1); assert.equal(display[0].kind, 'formula'); assert.equal(display[0].text, 'E=mc^2');
  const inline = pdfEditTargets('α', files, { file: 'main.tex', line: 2 });
  assert.equal(inline.length, 2); assert(inline.every(t => t.kind === 'formula'));
  assert.equal(pdfEditTargets('1', files, { file: 'main.tex', line: 6 }).length, 0);
});

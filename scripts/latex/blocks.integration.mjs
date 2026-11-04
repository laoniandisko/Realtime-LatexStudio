// Isolated real-engine check; it does not change the user's running Studio/project.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { build } from 'esbuild';
import { createBridge } from './bridge.mjs';

const bundled = await build({ stdin: { contents: `export * from './src/latex/rtex/block-edit'; export { mathHits } from './src/latex/rtex/math-hit'; export { PreviewModel } from './src/latex/rtex/vendor/model'; export {paragraphRegions} from './src/latex/rtex/paragraph-regions'; export {pdfEditTargets} from './src/latex/pdf-target';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { mathRegions, formulaTarget, paragraphTarget, blockInput, mathHits, PreviewModel, paragraphRegions, pdfEditTargets } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const bridge = createBridge();
const server = createServer((req, res) => bridge.middleware(req, res, () => { res.writeHead(404); res.end(); }));
server.on('upgrade', bridge.upgrade);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const session = await (await fetch(origin + '/__latex/session')).json();
const api = async (name, data = {}) => { const r = await fetch(origin + '/__latex/' + name, { method: 'POST', headers: { 'X-LaTeX-Token': session.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const v = await r.json(); if (!r.ok) throw Error(v.error); return v; };
const root = path.resolve('examples/latex-live-edit');
const project = await api('open', { path: root });
const original = project.files.find(f => f.name === 'main.tex').content;
const ws = new WebSocket(origin.replace('http:', 'ws:') + '/__latex/realtime?token=' + session.token, { origin });
const events = []; let protocolError;
ws.on('message', data => { const p = JSON.parse(data.toString()); events.push(p); if (p.type === 'error') protocolError = p.message; });
const wait = async (predicate, after = 0, timeout = 35000) => {
  const start = Date.now(); while (Date.now() - start < timeout) { if (protocolError) throw Error(protocolError); const index = events.findIndex((e, i) => i >= after && predicate(e)); if (index >= 0) return { packet: events[index], index }; await new Promise(r => setTimeout(r, 20)); }
  throw Error('Timed out: ' + events.slice(-4).map(e => e.type + ':' + (e.value?.event || e.value?.reply || '')).join(', '));
};
const send = value => ws.send(JSON.stringify(value));
let current = original;
const editDocument = async text => {
  const after = events.length; current = text; send({ type: 'document', file: 'main.tex', text });
  const reply = await wait(e => e.value?.reply === 'edit', after);
  return { after, revision: reply.packet.value.result.source_revision, route: reply.packet.value.result.routed };
};
const rendered = async edit => {
  const r = await wait(e => (e.value?.event === 'ParagraphUpdate' && e.value.versions.source_revision === edit.revision && ['ok', 'ok_degraded'].includes(e.value.status)) || (e.value?.event === 'LayoutUpdate' && e.value.versions.source_revision === edit.revision && e.value.compile?.state === 'Ok'), edit.after);
  return { route: edit.route, event: r.packet.value.event, ms: r.packet.value.timing?.total_us / 1000 || r.packet.value.wall_ms };
};
try {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  send({ type: 'start', main: 'main.tex', documents: project.files });
  const first = (await wait(e => e.value?.event === 'LayoutUpdate' && e.value.compile?.state === 'Ok')).packet.value;
  const spans = (await wait(e => e.type === 'spans' && e.file === 'main.tex')).packet.spans;
  const model = new PreviewModel(); model.applyLayout({ pages: first.pages_changed, pagesTotal: first.pages_total, placements: first.placements, keepFromRevision: null });
  let hitFormulas = 0, multiLineParagraphs = 0;
  for (const span of spans) {
    const source = Buffer.from(original).subarray(span.range.start, span.range.end).toString('utf8'), regions = mathRegions(source);
    const rows = []; for (const [page, update] of model.pages) for (const index of model.ownLines(page, span.id)) rows.push({ page, dl: update.dl, line: update.dl.lines[index], dx: 0, dy: 0 });
    const paragraphs = paragraphRegions(rows, source); multiLineParagraphs += paragraphs.filter(p => p.target.kind === 'paragraph' && p.rows.length > 1).length;
    if (source.includes('A coherent scene')) { const p = paragraphs.find(p => p.target.text.startsWith('A coherent')); assert(p && p.rows.length > 1); assert.equal(paragraphs.filter(p => p.target.kind === 'paragraph').length, 1); }
    if (!regions.length) continue;
    const hits = mathHits(rows, source); hitFormulas += hits.length;
    assert.equal(hits.length, regions.length, 'Native preview formula hit boxes must cover inline/display/align: ' + source.slice(0, 90));
  }
  assert.equal(hitFormulas, 4);
  assert(multiLineParagraphs > 1, 'Native hover regions must combine actual wrapped lines');
  const paragraph = paragraphTarget(current, current.indexOf('A coherent scene'));
  assert.equal(paragraph.kind, 'paragraph');
  assert(paragraph.text.startsWith('A coherent scene'));
  const prose = 'A coherent scene now supports continuous paragraph editing. We can replace several sentences together, add another sentence, and keep the surrounding section and document formatting. ' + 'Geometry and appearance remain consistent over time. '.repeat(5);
  const paragraphResult = await rendered(await editDocument(current.slice(0, paragraph.from) + blockInput(paragraph.mode, prose) + current.slice(paragraph.to)));
  assert.equal(paragraphResult.route, 'fast');
  assert(current.includes('\\section{Paragraph editing}'));
  const inline = formulaTarget(current, mathRegions(current).find(r => !r.display));
  const inlineResult = await rendered(await editDocument(current.slice(0, inline.from) + '\\frac{a+b}{c}' + current.slice(inline.to)));
  assert.equal(inlineResult.route, 'fast');
  const equation = formulaTarget(current, mathRegions(current).find(r => r.environment === 'equation'));
  const validEquation = current.slice(0, equation.from) + '\\frac{a+b}{c+d}' + current.slice(equation.to);
  const bad = await editDocument(current.slice(0, equation.from) + '\\frac{a' + current.slice(equation.to));
  await wait(e => (e.value?.event === 'Diagnostics' && e.value.items.some(d => d.severity === 'error')) || (e.value?.event === 'ParagraphUpdate' && !['ok', 'ok_degraded'].includes(e.value.status)), bad.after);
  assert.equal((await api('realtime-status')).active, true, 'Incomplete formula must not stop the engine');
  const recovery = await rendered(await editDocument(validEquation));
  assert(current.includes('\\label{eq:energy}'));
  const align = formulaTarget(current, mathRegions(current).find(r => r.environment === 'align'));
  const alignResult = await rendered(await editDocument(current.slice(0, align.from) + 'a + b &= c + d, \\\\\n  x^2 + y^2 &= z^2 + 1.' + current.slice(align.to)));
  send({ type: 'export' }); const pdf = (await wait(e => e.type === 'export')).packet;
  const data = Buffer.from(pdf.data, 'base64'); assert(data.subarray(0, 5).equals(Buffer.from('%PDF-')));
  await fs.mkdir('.runtime/rtex', { recursive: true }); await fs.writeFile('.runtime/rtex/blocks-export.pdf', data); await fs.writeFile('.runtime/rtex/blocks-export-source.tex', current);
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), original);
  // Regression for the user's actual route: original-engine PDF -> SyncTeX -> editable formula.
  const full = await api('compile', { main: 'main.tex', engine: 'pdflatex' }); assert(full.ok);
  const equationLine = original.slice(0, original.indexOf('  E = mc^2.')).split('\n').length;
  const forward = await api('synctex', { main: 'main.tex', direction: 'forward', file: 'main.tex', line: equationLine });
  const reverse = await api('synctex', { main: 'main.tex', page: Number(forward.Page), x: Number(forward.h || forward.x) + 4, y: Number(forward.v || forward.y) - 1 });
  assert(reverse.file && reverse.Line);
  const fullTargets = pdfEditTargets('E', [{ name: 'main.tex', content: original }], { file: reverse.file, line: Number(reverse.Line) });
  assert.equal(fullTargets.length, 1); assert.equal(fullTargets[0].kind, 'formula'); assert.equal(fullTargets[0].text, 'E = mc^2.');
  send({ type: 'stop' });
  console.log(JSON.stringify({ nativeFormulaHits: hitFormulas, multiLineParagraphRegions: multiLineParagraphs, fullPdfFormulaEditorTarget: fullTargets[0].text, paragraph: paragraphResult, inline: inlineResult, invalidFormulaRecovered: recovery, align: alignResult, exportBytes: data.length, labelsPreserved: true, sourceFileUnchanged: true }));
} finally {
  if (ws.readyState === WebSocket.OPEN) send({ type: 'stop' }); ws.close();
  await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

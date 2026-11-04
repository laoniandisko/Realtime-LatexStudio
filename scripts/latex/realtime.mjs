import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ResourceLoader } from './vendor/resources.mjs';
import { terminateTree } from './process.mjs';
import { documentEdit } from './document-edit.mjs';
import { prepareRtexTexdir } from './rtex-compat.mjs';
import { selectRtexCommand } from './rtex-command.mjs';
import {detectTexRuntime,withTexPath} from './runtime-paths.mjs';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distribution = path.join(checkout, '.runtime/rtex/bin/rtex-0.0.6-x86_64-pc-windows-msvc');
const executable = process.env.SIDEX_RTEX_PATH || path.join(distribution, 'bin/rtex.exe');
const texdir = process.env.SIDEX_RTEX_TEXDIR || path.join(distribution, 'share/rtex/tex');
const texRuntime=detectTexRuntime({root:checkout});
const texliveBin=texRuntime.bin;
const wireResource = resource => resource.data ? { ...resource, data: Buffer.from(resource.data).toString('base64') } : resource;

export function realtimeAvailability() {
  return { installed: existsSync(executable) && existsSync(path.join(texdir, 'rtex-dl.lua')), version: '0.0.6', texlive: texRuntime.texlive&&texRuntime.lualatex, engine: 'LuaLaTeX', source: 'https://github.com/HenryXiaoYang/realtime-tex' };
}

export class RealtimeManager {
  clients = new Set();
  child = null;
  generation = 0;
  log = '';
  root = '';
  main = '';
  build = '';
  documents = new Set();
  documentTexts = new Map();
  sourceRevision = 1;
  commands = [];
  spanCache = new Map();
  spanHistory = new Map();
  pages = new Map();
  fonts = new Map();
  images = new Map();
  lastLayout = null;
  lastPdf = null;
  pdfPaths = new Map();
  latestPdfPath = null;
  phase = 'stopped';
  engineHost = null;
  startupPending = false;
  startupReady = false;
  startupEdits = new Map();
  startupExport = false;
  chain = Promise.resolve();

  constructor(getProject, safe) { this.getProject = getProject; this.safe = safe; }
  async pdf(generation, layout) {
    if (Number(generation) !== this.generation) throw Error('Expired preview');
    const file = this.pdfPaths.get(Number(layout));
    if (!file) throw Error('Expired layout');
    const real = await fs.realpath(file);
    if (!real.startsWith(this.build + path.sep)) throw Error('Invalid preview path');
    return fs.readFile(real);
  }
  send(packet, only) {
    const text = JSON.stringify(packet);
    for (const client of only ? [only] : this.clients) if (client.readyState === 1) client.send(text);
  }
  subscribe(ws) {
    this.clients.add(ws);
    let commands = Promise.resolve();
    this.send({ type: 'availability', ...realtimeAvailability(), active: !!this.child }, ws);
    ws.on('close', () => { this.clients.delete(ws); if (!this.clients.size) void this.stop(); });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      commands = commands.then(() => this.handle(message, ws)).catch(error => this.send({ type: 'error', message: error.message }, ws));
    });
  }
  async handle(m, ws) {
    if (m.type === 'start') {
      const root = this.getProject();
      await this.safe(m.main);
      if (!m.main.endsWith('.tex')) throw Error('主文件必须是 .tex。');
      if (this.child && root === this.root && m.main === this.main) {
        if (this.fonts.size || this.images.size) this.send({ type: 'resources', fonts: [...this.fonts], images: [...this.images] }, ws);
        if (this.lastLayout) this.send({ type: 'engine-event', value: { ...this.lastLayout, pages_changed: [...this.pages.values()] }, pdf: this.lastPdf }, ws);
        for (const history of this.spanHistory.values()) for (const packet of history) this.send(packet, ws);
        for (const file of m.documents || []) {
          const current = this.startupPending ? this.startupEdits.get(file.name) ?? this.documentTexts.get(file.name) : this.documentTexts.get(file.name);
          if (/\.(tex|bib|sty|cls)$/.test(file.name) && current !== file.content) await this.handle({type:'document',file:file.name,text:file.content},ws);
        }
        return;
      }
      return this.start(root, m.main, m.documents || []);
    }
    if (m.type === 'stop') return this.stop();
    if (!this.child) throw Error('实时引擎尚未启动。');
    if (m.type === 'document') {
      await this.safe(m.file);
      if (!/\.(tex|bib|sty|cls)$/.test(m.file) || typeof m.text !== 'string') throw Error('该文件类型不支持实时更新。');
      this.documents.add(m.file);
      if (this.startupPending) {
        this.startupEdits.set(m.file,m.text);
        if (m.sequence !== undefined) this.send({type:'document-ack',file:m.file,sequence:m.sequence,staged:true,revision:this.sourceRevision},ws);
        return;
      }
      this.applyDocument(m,ws);
    } else if (m.type === 'layout') this.command({ cmd: 'request_layout' });
    else if (m.type === 'export') { if (this.startupPending) this.startupExport=true; else this.command({ cmd: 'export_pdf', out: path.join(this.build, 'export.pdf') }); }
  }
  applyDocument(m,ws) {
      const before = this.documentTexts.get(m.file);
      this.documentTexts.set(m.file, m.text);
      const metadata = { file: m.file, before, text: m.text, sequence: m.sequence };
      if (before === undefined || !m.file.endsWith('.tex')) this.command({ cmd: 'set_document', path: m.file, text: m.text }, metadata);
      else {
        const edit = documentEdit(before, m.text);
        if (edit) this.command({ cmd: 'edit', path: m.file, ...edit }, metadata);
        else if (m.sequence !== undefined) this.send({ type: 'document-ack', file: m.file, sequence: m.sequence, revision: this.sourceRevision }, ws);
      }
      this.spans(m.file);
  }
  command(value, metadata = {}) { if (this.child?.stdin.writable) { this.commands.push({ cmd: value.cmd, ...metadata }); this.child.stdin.write(JSON.stringify(value) + '\n'); } }
  spans(file) { this.command({ cmd: 'spans', path: file }, { file, source: this.documentTexts.get(file) }); }

  async start(root, main, documents) {
    await this.stop();
    if (!realtimeAvailability().installed) throw Error('realtime-tex 未安装，请运行 npm run latex:rtex:setup。');
    const preparedTexdir=await prepareRtexTexdir(texdir,path.join(checkout,'.runtime/rtex/compat'));
    const generation = ++this.generation;
    this.root = root; this.main = main; this.build = path.join(root, '.sidex-realtime');
    this.documents = new Set(documents.filter(f => /\.(tex|bib|sty|cls)$/.test(f.name)).map(f => f.name));
    this.documents.add(main);
    for (const file of this.documents) await this.safe(file);
    this.documentTexts = new Map(documents.map(f => [f.name, f.content]));
    if (!this.documentTexts.has(main)) this.documentTexts.set(main, await fs.readFile(await this.safe(main), 'utf8'));
    this.sourceRevision = 1; this.startupReady = false; this.startupPending = true; this.startupEdits.clear(); this.startupExport = false;
    this.fonts.clear(); this.images.clear(); this.pages.clear(); this.spanCache.clear(); this.spanHistory.clear(); this.commands = [];
    this.lastLayout = null; this.lastPdf = null; this.pdfPaths.clear(); this.latestPdfPath = null; this.log = ''; this.phase = 'starting';
    await fs.mkdir(this.build, { recursive: true });
    const env=withTexPath({...process.env,RTEX_TEXDIR:preparedTexdir,MIKTEX_ENABLE_INSTALLER:'0'},texRuntime);
    if (realtimeAvailability().texlive) {
      env.RTEX_TEXLIVE_BIN=texliveBin;
      for (const name of ['TEXMFVAR', 'TEXMFCONFIG', 'TEXMFHOME']) env[name] = path.join(texRuntime.texmfRoot,name==='TEXMFVAR'?'texmf-var':name==='TEXMFCONFIG'?'texmf-config':'texmf-home');
    } else {
      env.MIKTEX_USERDATA = path.join(checkout, '.runtime/miktex-data');
      env.MIKTEX_USERCONFIG = path.join(checkout, '.runtime/miktex-config');
    }
    const loader = new ResourceLoader(env, text => { this.log = (this.log + text + '\n').slice(-50000); });
    const command=await selectRtexCommand({executable,distribution,checkout,env});
    this.engineHost=command.kind;
    const child = spawn(command.command, [...command.prefix,'serve', '--project', root, '--main', main, '--build', this.build,...(command.suffix||[])], { cwd: root, env, windowsHide: true, stdio: 'pipe' });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    this.child = child;
    const watchdog = setTimeout(() => { if (this.generation === generation && !this.lastLayout) { this.send({ type: 'error', fallback: true, message: '实时引擎初始化超时，已停止；可使用原编译路径。' }); void this.stop(); } }, 90000);
    let buffer = '';
    this.send({ type: 'state', state: 'starting', message: '正在加载 LuaLaTeX 和原模板…' });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        this.chain = this.chain.then(async () => {
          if (this.generation !== generation) return;
          await this.receive(value, loader, generation);
          if (this.lastLayout) clearTimeout(watchdog);
        }).catch(error => this.send({ type: 'error', message: '实时预览处理失败：' + error.message }));
      }
    });
    child.stderr.on('data', chunk => { this.log = (this.log + chunk.toString()).slice(-50000); this.send({ type: 'log', text: chunk.toString() }); });
    child.once('error', error => { clearTimeout(watchdog); if (this.generation === generation) { this.child = null; this.send({ type: 'error', message: error.message }); } });
    child.once('exit', code => { clearTimeout(watchdog); if (this.generation === generation) { this.child = null; this.phase = 'stopped'; this.send({ type: 'state', state: 'stopped', message: `实时引擎已停止 (${code ?? 'interrupted'})` }); } });
    const originals = new Map(await Promise.all([...this.documents].map(async file => [file, await fs.readFile(await this.safe(file), 'utf8')])));
    this.documentTexts = new Map(originals);
    // Capture the source of the initial disk layout before restoring unsaved drafts.
    for (const [file, source] of originals) if (file.endsWith('.tex')) this.command({cmd:'spans',path:file},{file,source});
    for (const f of documents) if (this.documents.has(f.name)) {
      const disk = originals.get(f.name);
      if (disk !== f.content) this.startupEdits.set(f.name,f.content);
    }
    for (const file of this.documents) if (file.endsWith('.tex')) this.spans(file);
    this.startupReady = true; this.restoreStartup();
  }
  async receive(value, loader, generation = this.generation) {
    const request = value.reply ? this.commands.shift() : null;
    if (value.reply === 'error') {
      if (request?.sequence !== undefined) {
        if (this.documentTexts.get(request.file) === request.text) this.documentTexts.set(request.file, request.before);
        this.send({ type: 'document-ack', file: request.file, sequence: request.sequence, error: value.message });
      } else this.send({ type: 'error', message: value.message });
      return;
    }
    if (value.reply && value.result?.source_revision) this.sourceRevision = value.result.source_revision;
    if (request?.sequence !== undefined) this.send({ type: 'document-ack', file: request.file, sequence: request.sequence, revision: this.sourceRevision, route: value.result?.routed });
    if (value.reply === 'spans') {
      if (request?.file) {
        const packet = { type: 'spans', file: request.file, source: request.source, spans: value.spans, revision: this.sourceRevision };
        this.spanCache.set(request.file, packet);
        let history = this.spanHistory.get(request.file); if (!history) this.spanHistory.set(request.file, history = []);
        if (history.at(-1)?.source !== packet.source || JSON.stringify(history.at(-1)?.spans) !== JSON.stringify(packet.spans)) { history.push(packet); if (history.length > 24) history.splice(1,history.length-24); }
        this.send(packet);
      }
      return;
    }
    const dls = value.event === 'ParagraphUpdate' && value.dl ? [value.dl] : value.event === 'LayoutUpdate' ? (value.pages_changed || []).map(p => p.dl) : [];
    if (dls.length) {
      // A full PDF already contains the figures. Sending/rasterizing them again
      // can create dozens of concurrent PDF workers for a single paper.
      const hasPdf = value.event === 'LayoutUpdate' && (value.pdf_fallback || existsSync(path.join(this.build, 'bg', `layout-${value.versions.layout_version}.pdf`)));
      const [fonts, images] = await Promise.all([loader.fontsFor(dls, new Set(this.fonts.keys())), hasPdf ? new Map() : loader.imagesFor(dls, new Set(this.images.keys()), this.root)]);
      if (this.generation !== generation) return;
      const f = [...fonts].map(([key, resource]) => [key, wireResource(resource)]), i = [...images].map(([key, resource]) => [key, wireResource(resource)]);
      for (const pair of f) this.fonts.set(...pair); for (const pair of i) this.images.set(...pair);
      if (f.length || i.length) this.send({ type: 'resources', fonts: f, images: i });
    }
    let pdf;
    if (value.event === 'LayoutUpdate' && value.pages_total > 0 && value.compile?.state === 'Ok') {
      for (const page of value.pages_changed || []) this.pages.set(page.page, page);
      for (const n of this.pages.keys()) if (n > value.pages_total) this.pages.delete(n);
      this.lastLayout = value; this.phase = 'ready';
      const stable = path.join(this.build, 'bg', `layout-${value.versions.layout_version}.pdf`);
      let pdfPath = value.pdf_fallback || (existsSync(stable) ? stable : null);
      if (!pdfPath) {
        const bg = path.join(this.build, 'bg');
        const dirs = (await fs.readdir(bg).catch(() => [])).filter(x => /^pass-\d+$/.test(x)).sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
        for (const dir of dirs) { const candidate = path.join(bg, dir, path.basename(this.main, '.tex') + '.pdf'); if (existsSync(candidate)) { pdfPath = candidate; break; } }
      }
      if (pdfPath) {
        this.latestPdfPath = pdfPath;
        const layout = value.versions.layout_version;
        this.pdfPaths.set(layout, pdfPath);
        while (this.pdfPaths.size > 6) this.pdfPaths.delete(this.pdfPaths.keys().next().value);
        pdf = { generation: this.generation, layout }; this.lastPdf = pdf;
      }
      for (const file of this.documents) if (file.endsWith('.tex')) this.spans(file);
    }
    if (value.event === 'PdfExported' && value.path && value.converged) {
      const exported = path.resolve(value.path);
      if (exported.startsWith(this.build + path.sep)) this.send({ type: 'export', data: (await fs.readFile(exported)).toString('base64'), name: path.basename(this.main, '.tex') + '.pdf' });
    }
    if (value.event === 'PdfExported' && !value.converged) this.send({ type: 'error', message: '导出未收敛，请修复编译错误后重新导出。' });
    this.send({ type: 'engine-event', value, ...(pdf ? { pdf } : {}) });
    if (value.event === 'LayoutUpdate' && value.compile?.state === 'Ok') this.restoreStartup();
  }
  restoreStartup() {
    if (!this.startupPending || !this.startupReady || !this.lastLayout) return;
    this.startupPending = false;
    for (const [file,text] of this.startupEdits) this.applyDocument({file,text});
    this.startupEdits.clear();
    if (this.startupExport) { this.startupExport=false; this.command({cmd:'export_pdf',out:path.join(this.build,'export.pdf')}); }
  }

  async stop() {
    const child = this.child; this.child = null; this.generation++; this.phase = 'stopped';
    if (child) {
      try { child.stdin.end(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch {}
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
      await terminateTree(child); child.stdout.destroy(); child.stderr.destroy();
    }
    this.send({ type: 'state', state: 'stopped', message: '实时预览已关闭' });
  }
}

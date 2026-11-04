import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { runCommand } from './process.mjs';
import { RealtimeManager, realtimeAvailability } from './realtime.mjs';
import { ModelProvider } from './model-provider.mjs';
import {detectTexRuntime,resolveTexCommand,withTexPath} from './runtime-paths.mjs';
import { ProjectWorkspace, runProjectAgent, agentJobId } from './project-agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultProject = path.resolve(here, '../../examples/latex-paper');
const textExtensions = new Set(['.tex', '.bib', '.sty', '.cls', '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.py', '.sh', '.ps1', '.csv', '.ts', '.js', '.css', '.html']);
const ignored = new Set(['.git', 'node_modules', '.sidex-build', 'target', '.idea']);
const maxOutput = 150000;

async function run(program, args, cwd, timeout = 60000, options = {}) {
  const { bibliographyRoot = cwd, ...commandOptions } = options;
  // MiKTeX writes logs and configuration even on a successful compile. Keep
  // those process-local caches inside the checkout; no global setup changes.
  const runtime=detectTexRuntime({root:path.resolve(here,'../..')});
  const env=withTexPath({...process.env,MIKTEX_ENABLE_INSTALLER:'0'},runtime);
  program=resolveTexCommand(program,runtime);
  if(runtime.texlive&&runtime.texmfRoot)for(const [key,folder]of [['TEXMFVAR','texmf-var'],['TEXMFCONFIG','texmf-config'],['TEXMFHOME','texmf-home']])env[key]=path.join(runtime.texmfRoot,folder);
  env.BIBINPUTS = bibliographyRoot + path.delimiter + (env.BIBINPUTS || '');
  env.BSTINPUTS = bibliographyRoot + path.delimiter + (env.BSTINPUTS || '');
  if (process.platform === 'win32') {
    for (const [key, name] of [['MIKTEX_USERDATA', 'data'], ['MIKTEX_USERCONFIG', 'config']]) {
      env[key] = path.resolve(here, '../../.runtime/miktex-' + name);
      await fs.mkdir(env[key], { recursive: true });
    }
    const configDirectory = path.join(env.MIKTEX_USERCONFIG, 'miktex', 'config');
    await fs.mkdir(configDirectory, { recursive: true });
    try { await fs.writeFile(path.join(configDirectory, 'miktex.ini'), '[Core]\nNoRegistry = 1\n', { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return runCommand(program, args, { cwd, env, timeoutMs: timeout, maxOutput, ...commandOptions });
}

function validHost(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ''); }
function validOrigin(req) {
  if (!validHost(req)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 24 * 1024 * 1024) throw new Error('请求超过 24 MB。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }

export function createBridge({ modelStatePath = path.resolve(here, '../../.runtime/model-provider.json'), agentFetch = fetch, initialProject = defaultProject, sessionToken = randomBytes(32).toString('hex'), fixedProject = false, projectName, modelProviderInstance } = {}) {
  if(typeof sessionToken!=='string'||!/^[a-f0-9]{64}$/.test(sessionToken))throw Error('Invalid restored studio session token.');
  const token = sessionToken;
  let root = path.resolve(initialProject), compiling = false;
  const modelProvider = modelProviderInstance || new ModelProvider(modelStatePath);
  const displayName=()=>String((typeof projectName==='function'?projectName():projectName)||path.basename(root));
  let activeCompile = null;
  const realtime = new RealtimeManager(() => root, safe);
  const terminals = new Set();
  const activeAgents = new Set();
  let ptyPromise;
  const ptyModule = () => ptyPromise ??= import('node-pty').catch(() => null);
  async function safe(name, writing = false) {
    if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).some(x => x === '..' || x.startsWith('.'))) throw new Error('文件路径无效。');
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) throw new Error('文件必须在当前项目中。');
    const parent = await fs.realpath(writing ? path.dirname(full) : full);
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('项目之外的符号链接不受支持。');
    if (writing) {
      try { const real = await fs.realpath(full); if (!real.startsWith(root + path.sep)) throw new Error('项目之外的符号链接不受支持。'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return full;
  }
  async function list(dir = root, depth = 0) {
    if (depth > 8) return [];
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(e.name) || e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name), name = path.relative(root, full).replaceAll('\\', '/');
      if (e.isDirectory()) out.push(...await list(full, depth + 1));
      else if (textExtensions.has(path.extname(e.name).toLowerCase())) {
        const stat = await fs.stat(full); if (stat.size < 2 * 1024 * 1024) out.push({ name, content: await fs.readFile(full, 'utf8') });
      }
      if (out.length > 400) throw new Error('项目文字文件过多，请选择论文所在子目录。');
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function middleware(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/__latex/')) return next();
    if (!validOrigin(req)) return json(res, { error: '只允许本机同源请求。' }, 403);
    if (url.pathname === '/__latex/session' && req.method === 'GET') return json(res, { token, root, name: displayName(), runtime: 'local', pty: !!await ptyModule() });
    if (url.pathname === '/__latex/realtime-pdf' && req.method === 'GET') {
      if (req.headers['x-latex-token'] !== token) return json(res, { error: 'Invalid session' }, 403);
      try {
        const data = await realtime.pdf(url.searchParams.get('generation'), url.searchParams.get('layout'));
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
      } catch { json(res, { error: 'Preview expired' }, 404); }
      return;
    }
    if (req.headers['x-latex-token'] !== token || req.method !== 'POST') return json(res, { error: '会话已失效，请刷新。' }, 403);
    try {
      const data = await body(req);
      switch (url.pathname) {
        case '/__latex/realtime-status': return json(res, { ...realtimeAvailability(), active: !!realtime.child, phase: realtime.phase, host: realtime.engineHost });
        case '/__latex/compile-status': return json(res, activeCompile ? { active: true, id: activeCompile.id, phase: activeCompile.phase, elapsed: Date.now() - activeCompile.start, pid: activeCompile.pid, log: activeCompile.log } : { active: false });
        case '/__latex/cancel-compile': {
          const job = activeCompile;
          if (!job || (data.id && data.id !== job.id)) return json(res, { ok: true, cancelled: false });
          job.controller.abort();
          await job.done;
          return json(res, { ok: true, cancelled: true, id: job.id });
        }
        case '/__latex/project': return json(res, { root, name: displayName(), files: await list() });
        case '/__latex/open': {
          if (compiling) throw new Error('请等待编译结束。');
          const candidate = await fs.realpath(path.resolve(data.path));
          if (!(await fs.stat(candidate)).isDirectory()) throw new Error('请选择目录。');
          if(fixedProject&&candidate!==root)throw Error('请返回项目主页切换工作区。');
          const previous = root; for (const controller of activeAgents) controller.abort(); await realtime.stop(); root = candidate;
          try { const files = await list(); for (const t of terminals) t.close(); return json(res, { root, name: path.basename(root), files }); }
          catch (e) { root = previous; throw e; }
        }
        case '/__latex/save': {
          for (const f of data.files || []) { const full = await safe(f.name, true); await fs.writeFile(full, f.content, 'utf8'); }
          return json(res, { ok: true });
        }
        case '/__latex/create': {
          const full = await safe(data.name, true); await fs.writeFile(full, data.content || '', { encoding: 'utf8', flag: 'wx' }); return json(res, { ok: true });
        }
        case '/__latex/compile': {
          if (compiling) throw new Error('已有编译正在进行。');
          compiling = true;
          const job = { id: typeof data.id === 'string' ? data.id.slice(0, 100) : randomBytes(12).toString('hex'), controller: new AbortController(), start: Date.now(), phase: '准备编译', log: '', pid: null, timedOut: false, done: null, resolve: null };
          job.done = new Promise(resolve => { job.resolve = resolve; });
          activeCompile = job;
          const deadline = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, 60000);
          const disconnected = () => { if (!res.writableEnded) job.controller.abort(); };
          res.on('close', disconnected);
          if (res.destroyed) job.controller.abort();
          try {
            job.controller.signal.throwIfAborted();
            const main = await safe(data.main || 'main.tex');
            if (path.extname(main) !== '.tex') throw new Error('请选择 .tex 主文件。');
            const engine = ['pdflatex', 'xelatex', 'lualatex'].includes(data.engine) ? data.engine : 'pdflatex';
            const cwd = path.dirname(main), build = path.join(cwd, '.sidex-build');
            await fs.mkdir(build, { recursive: true });
            const start = Date.now();
            const args = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', `-output-directory=${build}`, '-jobname=main', path.basename(main)];
            const options = { signal: job.controller.signal, onSpawn: pid => { job.pid = pid; }, onOutput: text => { job.log = (job.log + text).slice(-maxOutput); } };
            job.phase = '第 1 遍编译';
            const first = await run(engine, args, cwd, 60000, options);
            job.controller.signal.throwIfAborted();
            let second = first;
            if (first.code === 0 && !first.cancelled && !first.timedOut) {
              const aux = await fs.readFile(path.join(build, 'main.aux'), 'utf8').catch(() => '');
              if (/\\bibdata\{/.test(aux)) {
                job.phase = 'BibTeX 参考文献';
                const bibliography = await run('bibtex', ['main'], build, 60000, { ...options, bibliographyRoot: cwd });
                job.controller.signal.throwIfAborted();
                if (bibliography.code !== 0) return json(res, { ok: false, log: job.log, duration: Date.now() - start, pdf: null });
              }
              job.phase = '第 2 遍编译';
              second = await run(engine, args, cwd, 60000, options);
              if (/\\bibdata\{/.test(aux) && second.code === 0) {
                job.controller.signal.throwIfAborted(); job.phase = '第 3 遍交叉引用';
                second = await run(engine, args, cwd, 60000, options);
              }
            }
            job.controller.signal.throwIfAborted();
            const log = job.log || second.stdout + '\n' + second.stderr;
            const ok = second.code === 0 && !second.timedOut && !second.cancelled;
            return json(res, { ok, log, duration: Date.now() - start, pdf: ok ? (await fs.readFile(path.join(build, 'main.pdf'))).toString('base64') : null, timedOut: second.timedOut });
          } catch (e) {
            if (job.controller.signal.aborted) return json(res, { ok: false, cancelled: !job.timedOut, timedOut: job.timedOut, log: job.log, duration: Date.now() - job.start, pdf: null });
            throw e;
          } finally {
            clearTimeout(deadline); res.off('close', disconnected);
            compiling = false; if (activeCompile === job) activeCompile = null;
            job.resolve();
          }
        }
        case '/__latex/synctex': {
          const main = await safe(data.main || 'main.tex');
          const pdf = path.join(path.dirname(main), '.sidex-build', 'main.pdf');
          const args = data.direction === 'forward' ? ['view', '-i', `${Number(data.line) || 1}:0:${await safe(data.file)}`, '-o', pdf] : ['edit', '-o', `${Number(data.page) || 1}:${Number(data.x) || 0}:${Number(data.y) || 0}:${pdf}`];
          const result = await run('synctex', args, path.dirname(main), 10000);
          const values = {};
          for (const line of result.stdout.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) values[line.slice(0, i)] = line.slice(i + 1); }
          if (values.Input) values.file = path.relative(root, path.resolve(path.dirname(main), values.Input)).replaceAll('\\', '/');
          return json(res, values);
        }
        case '/__latex/model-settings': return json(res, await modelProvider.settings());
        case '/__latex/models': return json(res, await modelProvider.discover(data));
        case '/__latex/model': return json(res, { ok: true, ...await modelProvider.save(data) });
        case '/__latex/chat': {
          const projectRoot = root;
          if (data.projectRoot && data.projectRoot !== projectRoot) throw Error('项目已切换，请在当前项目重新发送消息。');
          const connection = await modelProvider.connection();
          if (res.destroyed) return;
          if (root !== projectRoot) throw Error('项目已切换，智能体任务未启动。');
          const controller = new AbortController(), id = agentJobId(); activeAgents.add(controller);
          const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(240000)]);
          const stream = data.stream === true;
          if (stream) res.writeHead(200, { 'Content-Type':'application/x-ndjson; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
          const emit = event => { if (stream && !res.destroyed && !res.writableEnded) res.write(JSON.stringify({...event,root:projectRoot,jobId:id})+'\n'); };
          const disconnected = () => { if (!res.writableEnded) controller.abort(); }; res.on('close',disconnected);
          const workspace = new ProjectWorkspace(projectRoot,{documents:Array.isArray(data.documents)?data.documents:[],getRoot:()=>root,signal,
            backupRoot:path.resolve(here,'../../.runtime/agent-history',id),onChange:change=>emit({type:'file-change',change})});
          try {
            emit({type:'start'});
            const result = await runProjectAgent({connection,workspace,messages:data.messages||[],file:data.file,context:data.context,onEvent:emit,signal,fetcher:agentFetch});
            if (stream) { emit({type:'done',content:result.content,changedFiles:[...new Set(result.changes.map(change=>change.path))],toolCalls:result.toolCalls}); res.end(); }
            else json(res,result);
          } catch(error) {
            const message=signal.aborted?'智能体已停止，已完成的文件修改已保留。':error.message;
            if (stream) { emit({type:'error',message}); res.end(); }
            else json(res,{error:message,changes:workspace.changes},400);
          } finally { activeAgents.delete(controller); res.off('close',disconnected); }
          return;
        }
        default: return json(res, { error: 'Unknown operation' }, 404);
      }
    } catch (e) { return json(res, { error: e.message || String(e) }, 400); }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  async function upgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/__latex/realtime') {
      if (!validOrigin(req) || url.searchParams.get('token') !== token) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => realtime.subscribe(ws)); return;
    }
    if (url.pathname !== '/__latex/terminal') return;
    if (!validOrigin(req) || url.searchParams.get('token') !== token) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, async ws => {
      terminals.add(ws);
      const pty = await ptyModule();
      let proc;
      try {
        const windows = process.platform === 'win32';
        const shell = windows ? (process.env.COMSPEC?.replace(/cmd\.exe$/i, 'WindowsPowerShell\\v1.0\\powershell.exe') || 'powershell.exe') : (process.env.SHELL || '/bin/bash');
        if (pty) {
          const shellEnv = { ...process.env, TERM: 'xterm-256color' };
          // Do not inherit the agent runner's private PowerShell modules. The
          // standard system modules supply the normal local console instead.
          if (windows) shellEnv.PSModulePath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
          proc = pty.spawn(shell, windows ? ['-NoLogo', '-NoProfile'] : [], { name: 'xterm-256color', cols: 90, rows: 12, cwd: root, env: shellEnv });
          proc.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d })); });
          proc.onExit(() => ws.close());
          ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.type === 'input') proc.write(m.data); if (m.type === 'resize') proc.resize(Math.max(2, Math.min(500, m.cols)), Math.max(2, Math.min(200, m.rows))); } catch {} });
        } else {
          ws.send(JSON.stringify({ type: 'data', data: '\x1b[33mPTY 不可用；当前为按行执行的 Shell，暂不支持交互式程序。\x1b[0m\r\n> ' }));
          proc = spawn(windows ? 'powershell.exe' : '/bin/bash', windows ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'] : [], { cwd: root, windowsHide: true, stdio: 'pipe' });
          let line = '';
          for (const stream of [proc.stdout, proc.stderr]) stream.on('data', d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d.toString().replace(/\r?\n/g, '\r\n') })); });
          ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.type !== 'input') return; for (const c of m.data) { if (c === '\r') { proc.stdin.write(line + '\n'); line = ''; ws.send(JSON.stringify({ type: 'data', data: '\r\n' })); } else if (c === '\x7f') { line = line.slice(0, -1); ws.send(JSON.stringify({ type: 'data', data: '\b \b' })); } else if (c >= ' ' || c === '\n') { line += c; ws.send(JSON.stringify({ type: 'data', data: c })); } } } catch {} });
        }
        proc.on?.('error', e => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: '\r\n' + e.message })); });
        ws.on('close', () => { terminals.delete(ws); try { proc.kill(); } catch {} });
      } catch (e) { ws.send(JSON.stringify({ type: 'data', data: e.message })); ws.close(); }
    });
  }
  return { middleware, upgrade, close() { for (const controller of activeAgents) controller.abort(); activeCompile?.controller.abort(); void realtime.stop(); for (const t of terminals) t.close(); for (const client of realtime.clients) client.close(); wss.close(); } };
}

export function latexBridge() {
  return { name: 'sidex-latex-local-bridge', configureServer(server) { const bridge = createBridge(); server.middlewares.use(bridge.middleware); server.httpServer?.on('upgrade', bridge.upgrade); server.httpServer?.once('close', () => bridge.close()); } };
}

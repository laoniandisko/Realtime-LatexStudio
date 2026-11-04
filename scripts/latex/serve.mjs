import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioBridge } from './studio-bridge.mjs';
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-latex');
// Controlled updates retain the current local session so an open editor can save.
const resumePath=process.argv[2]==='--resume-state'?process.argv[3]:null;
const resume=resumePath?JSON.parse(await fs.readFile(resumePath,'utf8')):{};
if(resume.root&&!(await fs.stat(resume.root)).isDirectory())throw Error('Restored project directory is unavailable.');
const bridge = createStudioBridge({initialProject:resume.root,sessionToken:resume.token,projectStatePath:process.env.SIDEX_PROJECTS_STATE,projectsRoot:process.env.SIDEX_PROJECTS_DIR});
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = createServer((req, res) => bridge.middleware(req, res, async () => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const route=name==='/'||name==='/home'?'/home.html':name==='/workbench'?'/latex.html':name;
    const full=path.resolve(dist,'.'+route);
    if (!full.startsWith(dist + path.sep)) throw Error('Invalid path');
    const bytes = await fs.readFile(full); res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
}));
server.on('upgrade', bridge.upgrade);
const port=Number(process.env.SIDEX_PORT||1421);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SIDEX_PORT.');
server.listen(port,'127.0.0.1',()=>console.log('SideX LaTeX Studio: http://127.0.0.1:'+port+'/home'));
function stop() { bridge.close(); server.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

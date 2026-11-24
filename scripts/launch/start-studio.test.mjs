import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchStudio, validateOptions, buildRequired } from './start-studio.mjs';
import { terminateTree } from '../latex/process.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function freePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture() {
  // Spaces and Unicode catch shell quoting and Finder/desktop path regressions.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidex launcher 论文 '));
  await fs.mkdir(path.join(root, 'scripts/latex'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/latex'), { recursive: true });
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(root, 'src/latex/main.ts'), 'initial');
  await fs.writeFile(path.join(root, 'npm-fixture.mjs'), `
    import {promises as fs} from 'node:fs';
    await fs.appendFile('npm-calls.txt',process.argv.slice(2).join(' ')+'\\n');
    if(process.env.FIXTURE_NPM_FAIL==='1')process.exit(42);
    if(process.argv[2]==='ci'){
      await fs.mkdir('node_modules',{recursive:true});
      await fs.writeFile('node_modules/.package-lock.json','{}');
    }else{
      await fs.mkdir('dist-latex',{recursive:true});
      await fs.writeFile('dist-latex/home.html','<h1>Home</h1>');
      await fs.writeFile('dist-latex/latex.html','<h1>Editor</h1>');
    }
  `);
  await fs.writeFile(path.join(root, 'scripts/latex/serve.mjs'), `
    import {createServer} from 'node:http';
    if(process.env.FIXTURE_SERVICE_FAIL==='1')process.exit(23);
    createServer((req,res)=>{
      if(req.url==='/__latex/session'){
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({runtime:'local',token:'fixture-session'}));
      }else{res.end('<h1>Home</h1>');}
    }).listen(Number(process.env.SIDEX_PORT),'127.0.0.1');
  `);
  const env = { ...process.env, SIDEX_PORT: String(await freePort()) };
  const options = { root, env, noBrowser: true, npmCommand: [process.execPath, path.join(root, 'npm-fixture.mjs')], readyTimeoutMs: 5000 };
  async function stop() {
    const file = path.join(root, 'latex-service.pid');
    const pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
    if (pid > 0) {
      await terminateTree({ pid, exitCode: null, signalCode: null, kill: signal => { try { process.kill(pid, signal); } catch {} } });
      await fs.unlink(file).catch(() => {});
    }
  }
  async function cleanup() {
    await stop();
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('sidex launcher '));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { root, env, options, stop, cleanup };
}

test('Node and port validation rejects unsupported versions and malformed ports', () => {
  assert.throws(() => validateOptions({}, '22.10.9'), /Node.js 22.11/);
  assert.throws(() => validateOptions({}, '20.19.0'), /Node.js 22.11/);
  assert.equal(validateOptions({}, '22.11.0').port, 1421);
  assert.equal(validateOptions({ SIDEX_PORT: '65535' }, '24.0.0').port, 65535);
  for (const port of ['', '0', '65536', '12.5', '1e3', 'hello']) {
    assert.throws(() => validateOptions({ SIDEX_PORT: port }), /SIDEX_PORT/);
  }
});

test('first launch installs and builds, reuses the service, then skips unchanged work on restart', async () => {
  const f = await fixture();
  try {
    assert.equal((await launchStudio(f.options)).reused, false);
    assert.equal((await fetch(`http://127.0.0.1:${f.env.SIDEX_PORT}/home`)).status, 200);
    const calls = await fs.readFile(path.join(f.root, 'npm-calls.txt'), 'utf8');
    assert.match(calls, /^ci /);
    assert.match(calls, /\nrun build\n$/);
    assert.equal((await launchStudio(f.options)).reused, true);
    assert.equal(await fs.readFile(path.join(f.root, 'npm-calls.txt'), 'utf8'), calls);
    await f.stop();
    // Use another port so Windows has time to finish closing the old listener.
    f.env.SIDEX_PORT = String(await freePort());
    assert.equal((await launchStudio(f.options)).reused, false);
    assert.equal(await fs.readFile(path.join(f.root, 'npm-calls.txt'), 'utf8'), calls);
    assert.equal(await fs.stat(path.join(f.root, '.runtime/launcher.lock.json')).catch(() => null), null);
  } finally { await f.cleanup(); }
});

test('changed sources and a missing editor entry trigger rebuilding', async () => {
  const f = await fixture();
  try {
    await launchStudio(f.options);
    assert.equal(await buildRequired(f.root), false);
    const source = path.join(f.root, 'src/latex/main.ts');
    const newer = new Date(Date.now() + 5000);
    await fs.utimes(source, newer, newer);
    assert.equal(await buildRequired(f.root), true);
    const older = new Date(0);
    await fs.utimes(source, older, older);
    await fs.unlink(path.join(f.root, 'dist-latex/latex.html'));
    assert.equal(await buildRequired(f.root), true);
  } finally { await f.cleanup(); }
});

test('moving native dependencies between platforms forces a clean installation', async () => {
  const f = await fixture();
  try {
    await launchStudio(f.options);
    await f.stop();
    f.env.SIDEX_PORT = String(await freePort());
    await fs.writeFile(path.join(f.root, '.runtime/dependencies.platform.sha256'), 'another-platform');
    await launchStudio(f.options);
    const calls = await fs.readFile(path.join(f.root, 'npm-calls.txt'), 'utf8');
    assert.equal(calls.split('\n').filter(line => line.startsWith('ci ')).length, 2);
    assert.equal(calls.split('\n').filter(line => line === 'run build').length, 2);
  } finally { await f.cleanup(); }
});

test('failed dependency installation does not create a success stamp or leave a startup lock', async () => {
  const f = await fixture();
  try {
    f.env.FIXTURE_NPM_FAIL = '1';
    await assert.rejects(launchStudio(f.options), /Installing locked dependencies failed/);
    for (const file of ['dependencies.platform.sha256', 'launcher.lock.json']) {
      assert.equal(await fs.stat(path.join(f.root, '.runtime', file)).catch(() => null), null);
    }
    assert.equal(await fs.stat(path.join(f.root, 'latex-service.pid')).catch(() => null), null);
  } finally { await f.cleanup(); }
});

test('an occupied port is reported without installing dependencies or replacing its server', async () => {
  const f = await fixture();
  const server = createServer((req, res) => res.end('another application'));
  try {
    await listen(server);
    f.env.SIDEX_PORT = String(server.address().port);
    await assert.rejects(launchStudio(f.options), /already in use/);
    assert.equal(await fs.stat(path.join(f.root, 'npm-calls.txt')).catch(() => null), null);
    assert.equal(await (await fetch(`http://127.0.0.1:${f.env.SIDEX_PORT}`)).text(), 'another application');
  } finally { await new Promise(resolve => server.close(resolve)); await f.cleanup(); }
});

test('a server that exits before becoming ready fails and cleans up its PID and lock', async () => {
  const f = await fixture();
  try {
    f.env.FIXTURE_SERVICE_FAIL = '1';
    await assert.rejects(launchStudio(f.options), /did not become ready/);
    assert.equal(await fs.stat(path.join(f.root, 'latex-service.pid')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.root, '.runtime/launcher.lock.json')).catch(() => null), null);
  } finally { await f.cleanup(); }
});

test('a live startup lock blocks a second launcher without altering its owner', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, '.runtime'));
    const lock = path.join(f.root, '.runtime/launcher.lock.json');
    const owner = JSON.stringify({ pid: process.pid, id: 'first-launcher' });
    await fs.writeFile(lock, owner);
    await assert.rejects(launchStudio(f.options), /Another launcher/);
    assert.equal(await fs.readFile(lock, 'utf8'), owner);
    assert.equal(await fs.stat(path.join(f.root, 'npm-calls.txt')).catch(() => null), null);
  } finally { await f.cleanup(); }
});

test('POSIX entry point works from another directory and preserves arguments', { skip: process.platform === 'win32' }, async () => {
  const child = spawn('/bin/sh', [path.join(checkout, 'Start-LaTeXStudio.sh'), '--help'], { cwd: os.tmpdir() });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 0);
  assert.match(output, /--no-browser/);
});

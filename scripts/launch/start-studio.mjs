import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, openSync, closeSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand, terminateTree } from '../latex/process.mjs';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async file => fs.access(file).then(() => true, () => false);

export function validateOptions(env = process.env, version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 11)) {
    throw Error('Node.js 22.11 or newer is required. Install an LTS release from https://nodejs.org/.');
  }
  const raw = env.SIDEX_PORT ?? '1421';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw Error('SIDEX_PORT must be between 1 and 65535.');
  }
  return { port: Number(raw) };
}

export async function buildRequired(root) {
  const entries = ['dist-latex/home.html', 'dist-latex/latex.html'];
  let builtAt;
  try { builtAt = Math.min(...await Promise.all(entries.map(async name => (await fs.stat(path.join(root, name))).mtimeMs))); }
  catch { return true; }
  const newer = async file => {
    let stat;
    try { stat = await fs.stat(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory()) return stat.mtimeMs > builtAt;
    for (const entry of await fs.readdir(file)) if (await newer(path.join(file, entry))) return true;
    return false;
  };
  for (const name of ['src/latex', 'public', 'config/vite.latex.config.ts', 'package.json', 'package-lock.json']) {
    if (await newer(path.join(root, name))) return true;
  }
  return false;
}

async function serviceState(base) {
  let response;
  try { response = await fetch(base + '/__latex/session', { signal: AbortSignal.timeout(1500), redirect: 'error' }); }
  catch { return 'absent'; }
  try {
    const session = await response.json();
    if (response.ok && session.runtime === 'local' && typeof session.token === 'string' && session.token) {
      const home = await fetch(base + '/home', { signal: AbortSignal.timeout(1500), redirect: 'error' });
      await home.body?.cancel();
      if (home.ok) return 'ready';
    }
  } catch {}
  return 'busy';
}

async function acquireLock(runtime) {
  const file = path.join(runtime, 'launcher.lock.json');
  const identity = { pid: process.pid, id: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(identity)); } finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(file, 'utf8'));
          if (current.id === identity.id) await fs.unlink(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') { await fs.unlink(file).catch(() => {}); continue; }
        }
      }
      throw Error('Another launcher is already starting this checkout. See .runtime/npm.stdout.log and .runtime/npm.stderr.log. If a crashed launcher left a lock, remove .runtime/launcher.lock.json after checking that it has stopped.');
    }
  }
  throw Error('Unable to acquire the launcher lock. Run the launcher again.');
}

async function npmStage(root, runtime, env, npmCommand, args, label, timeoutMs) {
  const stdout = openSync(path.join(runtime, 'npm.stdout.log'), 'w');
  const stderr = await fs.open(path.join(runtime, 'npm.stderr.log'), 'w');
  const started = Date.now();
  console.log(label + '...');
  const heartbeat = setInterval(() => console.log(`${label}: ${Math.round((Date.now() - started) / 1000)}s elapsed`), 15000);
  try {
    const result = await runCommand(npmCommand[0], [...npmCommand.slice(1), ...args], {
      cwd: root, env, timeoutMs,
      onOutput: text => { writeSync(stdout, text); process.stdout.write(text); },
    });
    await stderr.writeFile(result.stderr);
    if (result.code !== 0) throw Error(`${label} ${result.timedOut ? 'timed out' : 'failed'}. See .runtime/npm.stdout.log and .runtime/npm.stderr.log.`);
  } finally { clearInterval(heartbeat); closeSync(stdout); await stderr.close(); }
}

function browserCommand(url, env, platform) {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return ['xdg-open', url];
  return null;
}

async function openBrowser(url, env, platform) {
  const command = browserCommand(url, env, platform);
  if (!command) return;
  try {
    const result = await runCommand(command[0], command.slice(1), { env, timeoutMs: 10000 });
    if (result.code !== 0) console.log(`Open this URL in your browser: ${url}`);
  } catch { console.log(`Open this URL in your browser: ${url}`); }
}

/** The root/npm overrides let integration tests exercise an isolated installation. */
export async function launchStudio({ root = checkout, env = process.env, noBrowser = false,
  platform = process.platform, npmCommand = ['npm'], readyTimeoutMs = 15000 } = {}) {
  const { port } = validateOptions(env);
  const base = `http://127.0.0.1:${port}`, url = base + '/home';
  const finish = async reused => {
    console.log(`SideX LaTeX Studio is ready: ${url}`);
    if (!noBrowser) await openBrowser(url, env, platform);
    return { url, reused };
  };
  const initial = await serviceState(base);
  if (initial === 'ready') return finish(true);
  if (initial === 'busy') throw Error(`Port ${port} is already in use. Set SIDEX_PORT to an unused port and try again.`);
  const runtime = path.join(root, '.runtime');
  await fs.mkdir(runtime, { recursive: true });
  const unlock = await acquireLock(runtime);
  try {
    // A second invocation may have started the server before this lock was acquired.
    if (await serviceState(base) === 'ready') return finish(true);
    const lockfile = await fs.readFile(path.join(root, 'package-lock.json')).catch(() => { throw Error('package-lock.json is missing. Download a complete source checkout.'); });
    const hash = createHash('sha256').update(lockfile).digest('hex');
    // Do not reuse native dependencies copied from Windows, another architecture,
    // or a different Node ABI when moving the same checkout between machines.
    const fingerprint = `${platform}-${process.arch}-${process.versions.modules}-${hash}`;
    const stamp = path.join(runtime, 'dependencies.platform.sha256');
    const installed = await fs.readFile(stamp, 'utf8').catch(() => '');
    let dependenciesChanged = false;
    if (installed.trim() !== fingerprint || !await exists(path.join(root, 'node_modules/.package-lock.json'))) {
      await npmStage(root, runtime, env, npmCommand, ['ci', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=info', '--foreground-scripts', '--fetch-timeout=20000', '--fetch-retries=1', '--fetch-retry-mintimeout=2000', '--fetch-retry-maxtimeout=5000'], 'Installing locked dependencies', 600000);
      await fs.writeFile(stamp, fingerprint + '\n');
      dependenciesChanged = true;
    }
    if (dependenciesChanged || await buildRequired(root)) {
      await npmStage(root, runtime, env, npmCommand, ['run', 'build'], 'Building SideX LaTeX Studio', 180000);
    }
    const stdout = openSync(path.join(root, 'latex-service.stdout.log'), 'a');
    const stderr = openSync(path.join(root, 'latex-service.stderr.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, 'scripts/latex/serve.mjs')], {
        cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
      });
    } finally { closeSync(stdout); closeSync(stderr); }
    let spawnError;
    child.once('error', error => { spawnError = error; });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await fs.writeFile(path.join(root, 'latex-service.pid'), String(child.pid) + '\n');
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline && !spawnError && child.exitCode === null && child.signalCode === null) {
        if (await serviceState(base) === 'ready') {
          child.unref();
          return await finish(false);
        }
        await pause(150);
      }
      throw Error(`SideX LaTeX Studio did not become ready on port ${port}. Check latex-service.stderr.log; another application may be using this port.`);
    } catch (error) {
      await terminateTree(child);
      await fs.unlink(path.join(root, 'latex-service.pid')).catch(() => {});
      throw error;
    }
  } finally { await unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--no-browser', '--help', '-h'].includes(arg))) {
    console.error('Unknown option. Usage: ./Start-LaTeXStudio.sh [--no-browser]');
    process.exitCode = 1;
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ./Start-LaTeXStudio.sh [--no-browser]\nSIDEX_PORT overrides port 1421. Requires Node.js >=22.11 and npm.');
  } else {
    launchStudio({ noBrowser: args.includes('--no-browser') }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

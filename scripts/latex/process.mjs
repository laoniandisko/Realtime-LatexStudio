import { spawn } from 'node:child_process';

// Kill the entire compiler tree: MiKTeX can start format builders and package
// helpers which inherit stdout and otherwise keep a request open indefinitely.
export async function terminateTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 2000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', done); killer.once('exit', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
}

export async function runCommand(program, args, { cwd, env = process.env, timeoutMs = 60000, signal, onSpawn, onOutput, maxOutput = 150000 } = {}) {
  if (signal?.aborted) return { stdout: '', stderr: '', code: null, cancelled: true, timedOut: false };
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, cancelled = false, settled = false, stopping = false;
    let drainTimer;
    const cleanup = () => { clearTimeout(timer); clearTimeout(drainTimer); signal?.removeEventListener('abort', abort); };
    const finish = code => {
      if (settled) return;
      settled = true; cleanup(); child.stdout.destroy(); child.stderr.destroy();
      resolve({ stdout, stderr, code, cancelled, timedOut });
    };
    const stop = async timeout => {
      if (settled || stopping) return;
      stopping = true; timedOut = timeout; cancelled = !timeout;
      await terminateTree(child);
      // Never depend on `close`: descendants may still hold inherited pipes.
      finish(null);
    };
    const abort = () => { void stop(false); };
    const timer = setTimeout(() => { void stop(true); }, timeoutMs);
    child.stdout.on('data', chunk => { const text = chunk.toString(); stdout = (stdout + text).slice(-maxOutput); onOutput?.(text); });
    child.stderr.on('data', chunk => { const text = chunk.toString(); stderr = (stderr + text).slice(-maxOutput); onOutput?.(text); });
    child.once('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.once('exit', code => {
      if (stopping) return;
      // Drain normal output briefly, then release handles even if a background
      // maintenance helper is holding a copy of a pipe open.
      drainTimer = setTimeout(() => finish(code), 250);
    });
    child.once('close', code => { if (!stopping) finish(code); });
    signal?.addEventListener('abort', abort, { once: true });
    onSpawn?.(child.pid);
    if (signal?.aborted) abort();
  });
}

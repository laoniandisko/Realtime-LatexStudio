import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from './process.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function assertStopped(pid) {
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(alive(pid), false, `process ${pid} must be stopped`);
}

test('normal compiler output drains and returns its exit code', async () => {
  const r = await runCommand(process.execPath, ['-e', "process.stdout.write('compiled');process.stderr.write('warning')"]);
  assert.equal(r.code, 0); assert.equal(r.stdout, 'compiled'); assert.equal(r.stderr, 'warning'); assert.equal(r.cancelled, false);
});
test('cancellation before launch never starts a process', async () => {
  const controller = new AbortController(); controller.abort(); let spawned = false;
  const r = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, onSpawn: () => { spawned = true; } });
  assert.equal(r.cancelled, true); assert.equal(spawned, false);
});
test('interrupt stops the compiler and its subprocess tree', async () => {
  const controller = new AbortController(); let parentPid;
  const source = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});c.on('spawn',()=>console.log('CHILD_PID:'+c.pid));setInterval(()=>{},1000)";
  let output = '';
  const r = await runCommand(process.execPath, ['-e', source], { signal: controller.signal, timeoutMs: 8000, onSpawn: pid => { parentPid = pid; }, onOutput: text => { output += text; if (/CHILD_PID:\d+/.test(output)) controller.abort(); } });
  assert.equal(r.cancelled, true); assert.equal(r.timedOut, false);
  const childPid = Number(output.match(/CHILD_PID:(\d+)/)?.[1]); assert.ok(childPid);
  await assertStopped(parentPid); await assertStopped(childPid);
});
test('timeout kills a hanging compiler and releases the runner', async () => {
  let pid; const start = Date.now();
  const r = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400, onSpawn: value => { pid = value; } });
  assert.equal(r.timedOut, true); assert.equal(r.cancelled, false); assert.ok(Date.now() - start < 4000); await assertStopped(pid);
});
test('background helpers holding inherited pipes cannot leave the request hanging', async () => {
  let pid;
  try {
    const source = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});console.log('HELPER_PID:'+c.pid);c.unref()";
    const r = await runCommand(process.execPath, ['-e', source], { timeoutMs: 5000 });
    pid = Number(r.stdout.match(/HELPER_PID:(\d+)/)?.[1]);
    assert.equal(r.code, 0); assert.equal(r.timedOut, false); assert.ok(pid);
  } finally { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); }
});

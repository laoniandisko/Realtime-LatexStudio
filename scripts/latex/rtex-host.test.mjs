import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
const run=promisify(execFile);
const candidates=[process.env.SIDEX_PYTHON,...(process.platform==='win32'?['C:/miniconda/python.exe','python']:['python3','python'])].filter(Boolean);
let python;
for(const candidate of candidates){try{await run(candidate,['--version'],{windowsHide:true,timeout:5000});python=candidate;break;}catch{}}
test('native-host scheduler, request ordering, export and malformed input guards', {skip:!python},async()=>{
 const result=await run(python,['-X','utf8','scripts/latex/rtex-host.test.py'],{windowsHide:true,timeout:10000});assert.match(result.stderr,/Ran 13 tests/);assert.match(result.stderr,/\bOK\b/);
});
const library='.runtime/rtex/bin/rtex-0.0.6-x86_64-pc-windows-msvc/lib/rtex_core.dll';
test('installed native host probe verifies ABI without opening a TeX project',{skip:!python||!fs.existsSync(library)||process.platform!=='win32'},async()=>{
 const {stdout}=await run(python,['-X','utf8','scripts/latex/rtex-host.py','--probe','--library',library],{windowsHide:true,timeout:10000});assert.deepEqual(JSON.parse(stdout),{version:'0.0.6',host:'ctypes-json'});
});

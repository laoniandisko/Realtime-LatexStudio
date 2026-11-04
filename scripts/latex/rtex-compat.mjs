import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';

const PATCH_VERSION='aux-tokenizer-matrix-v2';
const MANIFEST='.sidex-rtex-compat.json';
const ORIGINAL_LABELS=`    local n = 0
    for _, kv in ipairs(req.labels or {}) do
      token.set_macro(kv[1], kv[2], "global")
      n = n + 1
    end
    send{ op = "ok", id = n }`;
const PATCHED_LABELS=String.raw`    -- SideX aux-tokenizer-v1: let TeX tokenize active characters in aux macros.
    -- token.set_macro's simplified scanner does not preserve active ~ tokens.
    local n, definitions = 0, {}
    for _, kv in ipairs(req.labels or {}) do
      definitions[#definitions + 1] = "\\global\\expandafter\\def\\csname " .. kv[1] .. "\\endcsname{" .. kv[2] .. "}"
      n = n + 1
    end
    if n > 0 then
      local source = table.concat(definitions, "\n"):gsub("\r\n", "\n"):gsub("\r", "\n")
      local lines = {}
      for line in (source .. "\n"):gmatch("(.-)\n") do lines[#lines + 1] = line end
      tex.runtoks(function() tex.print(S.cct, lines) end)
    end
    send{ op = "ok", id = n }`;

const ORIGINAL_MATRIX_BINARY=String.raw`      self:bin_rec(0x28, pack("<Bi4i4", op, item[3], item[4]) .. bstr(item[5]))
    end
    return`;
const PATCHED_MATRIX_BINARY=String.raw`      self:bin_rec(0x28, pack("<Bi4i4", op, item[3], item[4]) .. bstr(item[5]))
      -- SideX matrix-codec-padding-v1: rtex 0.0.6's C encoder skips the item after M.
      self:bin_rec(0x21, pack("<i4i4i4i4", 0, 0, 0, 0))
    end
    return`;
const ORIGINAL_MATRIX_JSON=String.raw`  tgt[#tgt + 1] = item
end
function State:flag`;
const PATCHED_MATRIX_JSON=String.raw`  tgt[#tgt + 1] = item
  -- The padding has no ink or geometry, and is consumed by the defective C encoder.
  if item[1] == "M" then tgt[#tgt + 1] = { "r", 0, 0, 0, 0 } end
end
function State:flag`;
function patchDisplay(content){
 const source=content.toString('utf8').replace(/\r\n/g,'\n');
 if(source.includes(PATCHED_MATRIX_BINARY)&&source.includes(PATCHED_MATRIX_JSON))return Buffer.from(source);
 if(source.split(ORIGINAL_MATRIX_BINARY).length!==2||source.split(ORIGINAL_MATRIX_JSON).length!==2||source.includes('-- SideX matrix-codec-padding-')){
  throw Error('Unsupported realtime-tex matrix emitter: expected the verified 0.0.6 display-list writer.');
 }
 return Buffer.from(source.replace(ORIGINAL_MATRIX_BINARY,PATCHED_MATRIX_BINARY).replace(ORIGINAL_MATRIX_JSON,PATCHED_MATRIX_JSON));
}

const sha256=content=>createHash('sha256').update(content).digest('hex');
async function assets(directory,prefix=''){
 const entries=await fs.readdir(path.join(directory,prefix),{withFileTypes:true});
 const groups=await Promise.all(entries.map(async entry=>{
  const relative=prefix?`${prefix}/${entry.name}`:entry.name;
  if(relative===MANIFEST)return [];
  if(entry.isDirectory())return assets(directory,relative);
  if(!entry.isFile())throw Error(`Unsupported realtime-tex asset: ${relative}`);
  return [{relative,content:await fs.readFile(path.join(directory,...relative.split('/')))}];
 }));
 return groups.flat().sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0);
}
function fingerprint(files){
 const hash=createHash('sha256').update(PATCH_VERSION+'\0');
 for(const file of files)hash.update(file.relative+'\0'+file.content.length+'\0').update(file.content);
 return hash.digest('hex');
}
function patchServe(content){
 const source=content.toString('utf8').replace(/\r\n/g,'\n');
 if(source.includes(PATCHED_LABELS)&&!source.includes(ORIGINAL_LABELS))return Buffer.from(source);
 if(source.split(ORIGINAL_LABELS).length!==2||source.includes('-- SideX aux-tokenizer-')){
  throw Error('Unsupported realtime-tex aux-label scanner: expected the 0.0.6 labels block or the verified SideX tokenizer patch.');
 }
 return Buffer.from(source.replace(ORIGINAL_LABELS,PATCHED_LABELS));
}
async function validCache(directory,expected){
 let manifest;
 try{manifest=JSON.parse(await fs.readFile(path.join(directory,MANIFEST),'utf8'));}
 catch(error){if(error.code==='ENOENT')return false;throw Error(`Invalid realtime-tex compatibility cache: ${directory}`,{cause:error});}
 if(manifest.patchVersion!==PATCH_VERSION||manifest.inputHash!==expected.inputHash||manifest.serveHash!==expected.serveHash||JSON.stringify(manifest.assets)!==JSON.stringify(expected.assets))return false;
 try{
  return (await Promise.all(expected.assets.map(async asset=>sha256(await fs.readFile(path.join(directory,...asset.relative.split('/'))))===asset.hash))).every(Boolean);
 }
 catch(error){if(error.code==='ENOENT')return false;throw error;}
}

/** Return an immutable, content-addressed copy of known rtex assets. The official
 * distribution is never changed. Publication is atomic across concurrent callers. */
export async function prepareRtexTexdir(sourceDir,cacheRoot){
 const source=path.resolve(sourceDir),cache=path.resolve(cacheRoot),files=await assets(source);
 const serve=files.find(file=>file.relative==='rtex-serve.lua');
 if(!serve)throw Error('The realtime-tex asset directory has no rtex-serve.lua.');
 const inputHash=fingerprint(files);
 serve.content=patchServe(serve.content);
 const display=files.find(file=>file.relative==='rtex-dl.lua');
 if(!display)throw Error('The realtime-tex asset directory has no rtex-dl.lua.');
 display.content=patchDisplay(display.content);
 const manifest={patchVersion:PATCH_VERSION,inputHash,serveHash:sha256(serve.content),assets:files.map(file=>({relative:file.relative,hash:sha256(file.content)}))};
 const directory=path.join(cache,`${PATCH_VERSION}-${inputHash.slice(0,32)}`);
 if(await validCache(directory,manifest))return directory;
 await fs.mkdir(cache,{recursive:true});
 const temporary=path.join(cache,`.${path.basename(directory)}-${process.pid}-${randomUUID()}.tmp`);
 await fs.mkdir(temporary);
 try{
  await Promise.all(files.map(async file=>{
   const target=path.join(temporary,...file.relative.split('/'));
   await fs.mkdir(path.dirname(target),{recursive:true});
   await fs.writeFile(target,file.content,{flag:'wx'});
  }));
  await fs.writeFile(path.join(temporary,MANIFEST),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  try{await fs.rename(temporary,directory);}
  catch(error){
   // Windows and Unix report an existing destination differently. Only a complete,
   // verified publication by another caller permits reuse after rename fails.
   if(!await validCache(directory,manifest)){
    const exists=await fs.stat(directory).then(()=>true,statError=>{if(statError.code==='ENOENT')return false;throw statError;});
    if(exists)throw Error(`Incomplete or corrupted realtime-tex compatibility cache: ${directory}`,{cause:error});
    throw error;
   }
  }
  return directory;
 }finally{
  // This is the one directory created by this invocation, directly under cache.
  if(path.dirname(temporary)!==cache)throw Error('Invalid compatibility temporary directory.');
  await fs.rm(temporary,{recursive:true,force:true});
 }
}


function withoutComments(source){
 return source.split(/\r?\n/).map(line=>{for(let i=0;i<line.length;i++)if(line[i]==='%'){let escapes=0;for(let j=i-1;j>=0&&line[j]==='\\';j--)escapes++;if(escapes%2===0)return line.slice(0,i);}return line;}).join('\n');
}
/** Only old, explicit PostScript font requests need pdfLaTeX's OT1 default.
 * Modern fonts and explicit encodings are left to the author's preamble. */
export function needsLegacyOt1(main,documents){
 const files=new Map(documents.map(file=>[file.name.replaceAll('\\','/'),file.content]));
 const visited=new Set();let preamble='';
 function visit(name,depth=0){
  if(depth>12||visited.has(name)||!files.has(name))return;
  visited.add(name);const source=withoutComments(files.get(name)).split(/\\begin\s*\{document\}/,1)[0];preamble+='\n'+source;
  const follow=(input,extension)=>{
   input=input.trim();if(input.includes('\\'))return;
   const candidates=[path.posix.normalize(path.posix.join(path.posix.dirname(name),input)),path.posix.normalize(input)];
   for(const candidate of candidates){const found=files.has(candidate)?candidate:files.has(candidate+extension)?candidate+extension:null;if(found){visit(found,depth+1);break;}}
  };
  for(const match of source.matchAll(/\\(?:input|include)\s*\{([^{}]+)\}/g))follow(match[1],'.tex');
  for(const match of source.matchAll(/\\(documentclass|LoadClass|LoadClassWithOptions|usepackage|RequirePackage|RequirePackageWithOptions)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g))for(const file of match[2].split(','))follow(file,['documentclass','LoadClass','LoadClassWithOptions'].includes(match[1])?'.cls':'.sty');
 }
 visit(main.replaceAll('\\','/'));
 const packages=[...preamble.matchAll(/\\(?:usepackage|RequirePackage|RequirePackageWithOptions)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap(match=>match[1].split(',').map(name=>name.trim()));
 if(packages.some(name=>['fontenc','fontspec','unicode-math'].includes(name))||/\\(?:setmainfont|setsansfont|setmonofont|fontencoding)\b|\\(?:def|gdef|edef|xdef)\s*\\encodingdefault\b|\\(?:renewcommand|providecommand|newcommand)\s*\{?\\encodingdefault\b/.test(preamble))return false;
 return packages.some(name=>['times','mathptmx'].includes(name));
}

const RUNNER_VERSION='legacy-page-dimensions-ot1-v1';
const RUNNER_MANIFEST='.sidex-rtex-runner.json';
async function validRunner(directory,inputHash){
 let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(directory,RUNNER_MANIFEST),'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
 if(manifest.patchVersion!==RUNNER_VERSION||manifest.inputHash!==inputHash||!Array.isArray(manifest.assets)||JSON.stringify(manifest.assets.map(file=>file.relative))!==JSON.stringify(['bin/lualatex.exe','bin/lualatex.path','runner.cs']))return false;
 try{return(await Promise.all(manifest.assets.map(async file=>sha256(await fs.readFile(path.join(directory,...file.relative.split('/'))))===file.hash))).every(Boolean);}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
/** Give only this rtex session an early TeX prelude, before every generated
 * preamble, without changing a source byte or the official native distribution.
 * The runner inherits byte streams and owns its real engine in a Windows job. */
export async function prepareRtexLatexRunner(lualatex,cacheRoot,{platform=process.platform,env=process.env,compiler}={}){
 if(platform!=='win32')return path.dirname(lualatex);
 const executable=path.resolve(lualatex),cache=path.resolve(cacheRoot);
 const source=await fs.readFile(new URL('./rtex-latex-runner.cs',import.meta.url));
 const inputHash=sha256(RUNNER_VERSION+'\0'+executable+'\0'+sha256(source));
 const directory=path.join(cache,RUNNER_VERSION+'-'+inputHash.slice(0,32)),bin=path.join(directory,'bin');
 if(await validRunner(directory,inputHash))return bin;
 const windows=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows';
 const candidates=compiler?[compiler]:[path.join(windows,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),path.join(windows,'Microsoft.NET/Framework/v4.0.30319/csc.exe')];
 for(const candidate of candidates)if(await fs.stat(candidate).then(s=>s.isFile(),()=>false)){compiler=candidate;break;}
 if(!compiler)throw Error('The Windows .NET Framework compiler is required to prepare the LuaLaTeX compatibility runner.');
 if(!(await fs.stat(executable)).isFile())throw Error('The real LuaLaTeX executable is unavailable.');
 await fs.mkdir(cache,{recursive:true});
 const temporary=path.join(cache,'.'+path.basename(directory)+'-'+process.pid+'-'+randomUUID()+'.tmp');
 await fs.mkdir(path.join(temporary,'bin'),{recursive:true});
 try{
  const sourceFile=path.join(temporary,'runner.cs'),target=path.join(temporary,'bin/lualatex.exe');
  await fs.writeFile(sourceFile,source,{flag:'wx'});await fs.writeFile(path.join(temporary,'bin/lualatex.path'),executable+'\n',{flag:'wx'});
  await new Promise((resolve,reject)=>execFile(compiler,['/nologo','/optimize+','/target:exe','/out:'+target,sourceFile],{env,windowsHide:true,timeout:20000,maxBuffer:64000},(error,stdout,stderr)=>error?reject(Error('LuaLaTeX runner compilation failed: '+(stderr||stdout||error.message).slice(-3000))):resolve()));
  const generated=await assets(temporary),manifest={patchVersion:RUNNER_VERSION,inputHash,assets:generated.map(file=>({relative:file.relative,hash:sha256(file.content)}))};
  await fs.writeFile(path.join(temporary,RUNNER_MANIFEST),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  try{await fs.rename(temporary,directory);}catch(error){if(!await validRunner(directory,inputHash))throw Error('Incomplete or corrupted LuaLaTeX compatibility runner: '+directory,{cause:error});}
  return bin;
 }finally{if(path.dirname(temporary)!==cache)throw Error('Invalid LuaLaTeX runner temporary directory.');await fs.rm(temporary,{recursive:true,force:true});}
}

import {existsSync,readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const programs=['lualatex','pdflatex','xelatex','bibtex','biber','synctex','kpsewhich','latexmk'];
const engines=['lualatex','pdflatex','xelatex'];

/** Discover executables without changing PATH, registry, or global TeX settings.
 * A local ignored config can point to a custom installation: {"bin":"..."}. */
export function detectTexRuntime({root=defaultRoot,env=process.env,platform=process.platform,exists=existsSync,readFile=readFileSync,readDir=readdirSync}={}){
 const windows=platform==='win32',p=windows?path.win32:path.posix,delimiter=windows?';':':',warnings=[],candidates=[],seen=new Set();
 const expand=value=>String(value).trim().replace(/^"(.*)"$/,'$1').replace(/^~(?=[\\/]|$)/,env.USERPROFILE||env.HOME||'~').replace(/%([^%]+)%/g,(all,key)=>env[key]??all);
 const add=(value,source,explicit=false)=>{if(typeof value!=='string'||!value.trim())return;const bin=p.resolve(root,expand(value));const key=windows?bin.toLowerCase():bin;if(!seen.has(key)){seen.add(key);candidates.push({bin,source,explicit});}};
 for(const key of ['SIDEX_TEXLIVE_BIN','SIDEX_TEX_BIN'])if(env[key])add(env[key],key,true);
 const configPath=p.join(root,'.runtime','tex-config.json');
 try{const config=JSON.parse(String(readFile(configPath,'utf8')).replace(/^\uFEFF/,''));if(typeof config.bin==='string')add(config.bin,'local-config',true);else warnings.push('Ignored tex-config.json: expected a bin string.');}
 catch(error){if(error.code!=='ENOENT')warnings.push('Ignored unreadable or invalid tex-config.json.');}
 for(const architecture of windows?['windows','win32']:platform==='darwin'?['universal-darwin','x86_64-darwin','aarch64-darwin']:['x86_64-linux','aarch64-linux'])add(p.join(root,'.runtime','texlive','bin',architecture),'managed');
 for(const directory of String(env.PATH||env.Path||'').split(delimiter))add(directory,'PATH');
 if(windows){
  const drive=env.SystemDrive||env.SYSTEMDRIVE||'C:',texlive=p.join(drive+'\\','texlive');
  try{for(const year of readDir(texlive).filter(name=>/^\d{4}$/.test(name)).sort().reverse())for(const bin of ['windows','win32'])add(p.join(texlive,year,'bin',bin),'standard-texlive');}catch{}
  for(const base of [env.LOCALAPPDATA&&p.join(env.LOCALAPPDATA,'Programs'),env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean))for(const installation of ['MiKTeX','MiKTeX 2.9'])add(p.join(base,installation,'miktex','bin','x64'),'standard-miktex');
 }else{
  for(const bin of ['/Library/TeX/texbin','/usr/local/bin','/usr/bin'])add(bin,'system');
  try{for(const year of readDir('/usr/local/texlive').filter(name=>/^\d{4}$/.test(name)).sort().reverse())for(const arch of platform==='darwin'?['universal-darwin','x86_64-darwin','aarch64-darwin']:['x86_64-linux','aarch64-linux'])add(p.join('/usr/local/texlive',year,'bin',arch),'standard-texlive');}catch{}
 }
 const describe=candidate=>{
  const commands={};for(const name of programs){const executable=p.join(candidate.bin,name+(windows?'.exe':''));if(exists(executable))commands[name]=executable;}
  if(!engines.some(name=>commands[name]))return null;
  const miktex=exists(p.join(candidate.bin,'initexmf'+(windows?'.exe':'')))||/miktex/i.test(candidate.bin);
  const texlive=!miktex&&(exists(p.join(candidate.bin,'tlmgr'+(windows?'.bat':'')))||/texlive/i.test(candidate.bin));
  return {...candidate,commands,distribution:miktex?'miktex':texlive?'texlive':'unknown',texlive,lualatex:!!commands.lualatex,pdflatex:!!commands.pdflatex,xelatex:!!commands.xelatex,synctex:!!commands.synctex,texmfRoot:texlive&&p.basename(p.dirname(candidate.bin)).toLowerCase()==='bin'?p.dirname(p.dirname(candidate.bin)):null};
 };
 let fallback=null,selected=null;
 for(const candidate of candidates){const found=describe(candidate);if(!found){if(candidate.explicit)warnings.push('Configured TeX directory has no supported engine ('+candidate.source+').');continue;}if(candidate.explicit||found.lualatex){selected=found;break;}fallback??=found;}
 selected??=fallback;
 return selected?{...selected,available:true,warnings,platform}:{bin:null,source:null,distribution:null,commands:{},available:false,texlive:false,lualatex:false,pdflatex:false,xelatex:false,synctex:false,texmfRoot:null,warnings,platform};
}

export function resolveTexCommand(program,runtime=detectTexRuntime()){
 return runtime.commands[program]||program;
}

/** Clone the environment and prepend a detected bin, with one PATH key even on Windows. */
export function withTexPath(env,runtime=detectTexRuntime({env})){
 const result={...env};if(!runtime.bin)return result;
 const prior=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1]||'';
 for(const key of Object.keys(result))if(key.toLowerCase()==='path')delete result[key];
 result.PATH=runtime.bin+(prior?(runtime.platform==='win32'?';':':')+prior:'');return result;
}

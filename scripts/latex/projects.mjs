import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const queues=new Map();
const skipped=new Set(['node_modules','target','dist','dist-latex','build']);
const MAX_ENTRIES=4000,MAX_TEX=400,MAX_DEPTH=8,MAX_TEXT_BYTES=2*1024*1024;
const TEMPLATES={
 blank:'\\documentclass{article}\n\\begin{document}\n\nStart writing here.\n\n\\end{document}\n',
 article:'\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{amsmath,graphicx}\n\n\\title{New article}\n\\author{}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nWrite your abstract here.\n\\end{abstract}\n\n\\section{Introduction}\nStart writing your article here.\n\n\\section{Method}\nAn example equation:\n\\begin{equation}\nE = mc^2.\n\\end{equation}\n\n\\section{Conclusion}\nSummarize your findings here.\n\n\\end{document}\n'
};

function nameOf(value){
 if(typeof value!=='string')throw Error('Project name is required.');
 const name=value.trim();
 if(!name||name.length>120||name==='.'||name==='..'||/[\\/\u0000-\u001f\u007f]/.test(name))throw Error('Use a project name of 1–120 characters without path separators.');
 return name;
}
function absoluteFolder(value){
 if(typeof value!=='string'||!value.trim()||value.includes('\0')||!path.isAbsolute(value)||value.split(/[\\/]/).includes('..'))throw Error('Choose an absolute project folder path without traversal.');
 const full=path.resolve(value);if(samePath(full,path.parse(full).root))throw Error('Choose a project folder rather than a filesystem root.');return full;
}
function samePath(a,b){return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
function inside(root,file){const relative=path.relative(root,file);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));}
async function folder(value){
 const full=absoluteFolder(value),stat=await fs.lstat(full);
 if(stat.isSymbolicLink())throw Error('A symbolic link cannot be used as a project root.');
 if(!stat.isDirectory())throw Error('Choose a project folder.');
 return fs.realpath(full);
}
async function inspect(root){
 const canonical=await folder(root);
 if(!samePath(canonical,path.resolve(root)))throw Error('The project folder has been redirected.');
 let entries=0,truncated=false;const tex=[];
 async function visit(directory,depth){
  if(depth>MAX_DEPTH){truncated=true;return;}
  const items=await fs.readdir(directory,{withFileTypes:true});
  items.sort((a,b)=>Number(b.isFile())-Number(a.isFile())||a.name.localeCompare(b.name));
  for(const item of items){
   if(item.name.startsWith('.')||skipped.has(item.name)||item.isSymbolicLink())continue;
   if(++entries>MAX_ENTRIES||tex.length>=MAX_TEX){truncated=true;return;}
   const full=path.join(directory,item.name);
   if(item.isDirectory())await visit(full,depth+1);
   else if(item.isFile()&&item.name.endsWith('.tex')){
    const stat=await fs.lstat(full);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_TEXT_BYTES)tex.push(path.relative(root,full).split(path.sep).join('/'));
   }
  }
 }
 await visit(root,0);
 tex.sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
 let main=tex.find(file=>file==='main.tex')||null;
 if(!main)for(const file of tex){
  const full=path.join(root,...file.split('/'));
  const real=await fs.realpath(full);
  if(!inside(root,real))continue;
  const handle=await fs.open(full,'r');
  try{const buffer=Buffer.alloc(65536);const read=await handle.read(buffer,0,buffer.length,0);const header=buffer.toString('utf8',0,read.bytesRead).replace(/(^|[^\\])%[^\n]*/g,'$1');if(/\\documentclass\b/.test(header)){main=file;break;}}
  finally{await handle.close();}
 }
 return {main:main||tex[0]||null,texFiles:tex.length,truncated,available:true};
}

/** Local project metadata only. Archive/rename never delete or move paper files. */
export class ProjectCatalog {
 constructor({statePath=path.join(checkout,'.local/projects.json'),projectsRoot=path.join(checkout,'.local/projects')}={}){
  this.statePath=path.resolve(statePath);this.projectsRoot=path.resolve(projectsRoot);
 }
 async run(task){
  const previous=queues.get(this.statePath)||Promise.resolve();
  const result=previous.catch(()=>{}).then(task);const settled=result.catch(()=>{});queues.set(this.statePath,settled);
  void settled.finally(()=>{if(queues.get(this.statePath)===settled)queues.delete(this.statePath);});
  return result;
 }
 async read(){
  let value;
  try{value=JSON.parse(await fs.readFile(this.statePath,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {version:1,projects:[]};throw Error('The local project index could not be read. It has not been overwritten.',{cause:error});}
  if(value?.version!==1||!Array.isArray(value.projects))throw Error('The local project index has an unsupported format.');
  const ids=new Set();
  for(const item of value.projects){
   if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.root!=='string'||!path.isAbsolute(item.root))throw Error('The local project index contains invalid entries.');
   nameOf(item.name);ids.add(item.id);
  }
  return value;
 }
 async write(value){
  await fs.mkdir(path.dirname(this.statePath),{recursive:true});
  const temporary=this.statePath+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});await fs.rename(temporary,this.statePath);}
  finally{await fs.rm(temporary,{force:true});}
 }
 find(state,id){const project=state.projects.find(item=>item.id===id);if(!project)throw Error('Project not found.');return project;}
 async entry(project){
  try{return {...project,...await inspect(project.root)};}
  catch{return {...project,available:false,issue:'The project folder is unavailable, moved or redirected.'};}
 }
 async list({includeArchived=true,search=''}={}){
  return this.run(async()=>{
   const state=await this.read(),query=String(search).trim().toLocaleLowerCase();
   const candidates=state.projects.filter(project=>(includeArchived||!project.archived)&&(!query||project.name.toLocaleLowerCase().includes(query)));
   const projects=await Promise.all(candidates.map(project=>this.entry(project)));
   projects.sort((a,b)=>String(b.lastOpenedAt||b.updatedAt||b.createdAt).localeCompare(String(a.lastOpenedAt||a.updatedAt||a.createdAt))||a.name.localeCompare(b.name));
   return {projects,projectsRoot:this.projectsRoot};
  });
 }
 async create({name,template='article'}={}){
  const displayName=nameOf(name);if(!Object.hasOwn(TEMPLATES,template))throw Error('Choose the blank or article template.');
  return this.run(async()=>{
   const state=await this.read();await fs.mkdir(this.projectsRoot,{recursive:true});
   const base=await folder(this.projectsRoot),id=randomUUID(),root=path.join(base,id);
   if(!inside(base,root)||path.dirname(root)!==base)throw Error('Invalid managed project path.');
   await fs.mkdir(root);await fs.writeFile(path.join(root,'main.tex'),TEMPLATES[template],{encoding:'utf8',flag:'wx'});
   const now=new Date().toISOString(),project={id,name:displayName,root,managed:true,archived:false,createdAt:now,updatedAt:now,lastOpenedAt:null,...await inspect(root)};
   state.projects.push(project);await this.write(state);return {...project};
  });
 }
 async import({path:input,name}={}){
  const requested=absoluteFolder(input),displayName=name===undefined||typeof name==='string'&&!name.trim()?null:nameOf(name);
  return this.run(async()=>{
   const root=await folder(requested),details=await inspect(root);
   if(!details.texFiles)throw Error('The selected folder has no editable .tex files.');
   const state=await this.read(),existing=state.projects.find(project=>samePath(project.root,root));
   if(existing){existing.archived=false;existing.updatedAt=new Date().toISOString();Object.assign(existing,details);if(displayName)existing.name=displayName;await this.write(state);return {...existing};}
   const now=new Date().toISOString(),project={id:randomUUID(),name:displayName||nameOf(path.basename(root)),root,managed:false,archived:false,createdAt:now,updatedAt:now,lastOpenedAt:null,...details};
   state.projects.push(project);await this.write(state);return {...project};
  });
 }
 async rename(id,name){const displayName=nameOf(name);return this.run(async()=>{const state=await this.read(),project=this.find(state,id);project.name=displayName;project.updatedAt=new Date().toISOString();await this.write(state);return this.entry(project);});}
 async setArchived(id,archived){return this.run(async()=>{const state=await this.read(),project=this.find(state,id);project.archived=archived;project.updatedAt=new Date().toISOString();await this.write(state);return this.entry(project);});}
 async archive(id){return this.setArchived(id,true);}
 async restore(id){return this.setArchived(id,false);}
 async open(id){
  return this.run(async()=>{
   const state=await this.read(),project=this.find(state,id);
   if(project.archived)throw Error('Restore the archived project before opening it.');
   const details=await inspect(project.root);if(!details.texFiles)throw Error('The project has no editable .tex files.');
   Object.assign(project,details,{lastOpenedAt:new Date().toISOString()});await this.write(state);return {...project};
  });
 }
 async handle(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid project request.');
  switch(input.action||'list'){
   case 'list':return this.list(input);
   case 'create':return {project:await this.create(input)};
   case 'import':return {project:await this.import(input)};
   case 'rename':return {project:await this.rename(input.id,input.name)};
   case 'archive':case 'remove':return {project:await this.archive(input.id)};
   case 'restore':return {project:await this.restore(input.id)};
   case 'open':return {project:await this.open(input.id)};
   default:throw Error('Unknown project action.');
  }
 }
}

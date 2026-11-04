import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ProjectCatalog} from './projects.mjs';

const runtime=path.resolve('.runtime');await fs.mkdir(runtime,{recursive:true});
async function fixture(){
 const base=await fs.mkdtemp(path.join(runtime,'projects-test-')),statePath=path.join(base,'index.json'),projectsRoot=path.join(base,'managed');
 return {base,statePath,projectsRoot,catalog:new ProjectCatalog({statePath,projectsRoot}),async cleanup(){assert.equal(path.dirname(base),runtime);await fs.rm(base,{recursive:true,force:true});}};
}
async function external(f,name='paper',source='\\documentclass{article}\n\\begin{document}External paper\\end{document}\n'){
 const root=path.join(f.base,name);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'paper.tex'),source);return root;
}

test('new projects persist in UUID folders with portable compilable templates and no title interpolation',async()=>{
 const f=await fixture();try{
  assert.deepEqual((await f.catalog.list()).projects,[]);
  const {project}=await f.catalog.handle({action:'create',name:'论文 #1 {A}',template:'article'});
  assert.equal(project.name,'论文 #1 {A}');assert.equal(project.managed,true);assert.equal(project.main,'main.tex');assert.equal(project.texFiles,1);assert.equal(project.archived,false);assert.equal(project.lastOpenedAt,null);
  assert.equal(path.dirname(project.root),await fs.realpath(f.projectsRoot));assert.notEqual(path.basename(project.root),project.name);
  const source=await fs.readFile(path.join(project.root,'main.tex'),'utf8');assert.match(source,/\\documentclass/);assert.match(source,/\\begin\{document\}/);assert(!source.includes(project.name));
  const reopened=new ProjectCatalog({statePath:f.statePath,projectsRoot:f.projectsRoot});assert.equal((await reopened.list()).projects[0].id,project.id);
  const blank=await f.catalog.create({name:'Blank',template:'blank'});assert.match(await fs.readFile(path.join(blank.root,'main.tex'),'utf8'),/Start writing here/);
 }finally{await f.cleanup();}
});

test('import registers an existing folder without moving or modifying its files and deduplicates it',async()=>{
 const f=await fixture();try{
  const root=await external(f),before=await fs.readFile(path.join(root,'paper.tex'));
  const project=await f.catalog.import({path:root});assert.equal(project.managed,false);assert.equal(project.root,await fs.realpath(root));assert.equal(project.main,'paper.tex');
  const duplicate=await f.catalog.import({path:root,name:'Renamed import'});assert.equal(duplicate.id,project.id);assert.equal(duplicate.name,'Renamed import');assert.equal((await f.catalog.list()).projects.length,1);assert.equal((await f.catalog.import({path:root,name:''})).name,'Renamed import');
  assert((await fs.readFile(path.join(root,'paper.tex'))).equals(before));assert.equal((await fs.readdir(root)).length,1);
  if(process.platform==='win32')assert.equal((await f.catalog.import({path:root.toUpperCase()})).id,project.id);
 }finally{await f.cleanup();}
});

test('rename and archive operate only on metadata, and archived entries can be restored',async()=>{
 const f=await fixture();try{
  const project=await f.catalog.create({name:'Original'}),before=await fs.readFile(path.join(project.root,'main.tex'));
  const renamed=await f.catalog.rename(project.id,'New display title');assert.equal(renamed.root,project.root);assert.equal(renamed.name,'New display title');assert((await fs.readFile(path.join(project.root,'main.tex'))).equals(before));
  await f.catalog.handle({action:'remove',id:project.id});assert.equal((await f.catalog.list()).projects[0].archived,true);assert.equal((await f.catalog.list({includeArchived:false})).projects.length,0);await assert.rejects(f.catalog.open(project.id),/Restore/);
  await f.catalog.restore(project.id);assert.equal((await f.catalog.open(project.id)).archived,false);assert((await fs.readFile(path.join(project.root,'main.tex'))).equals(before));
 }finally{await f.cleanup();}
});

test('open records recency and refreshes project metadata without changing source',async()=>{
 const f=await fixture();try{
  const alpha=await f.catalog.create({name:'Alpha'});await f.catalog.create({name:'Beta'});await fs.writeFile(path.join(alpha.root,'chapter.tex'),'A chapter');await new Promise(resolve=>setTimeout(resolve,5));
  const opened=await f.catalog.open(alpha.id);assert.equal(opened.texFiles,2);assert.equal(typeof opened.lastOpenedAt,'string');assert.equal((await f.catalog.list()).projects[0].id,alpha.id);assert.equal((await f.catalog.list({search:'ALPH'})).projects[0].id,alpha.id);
 }finally{await f.cleanup();}
});

test('concurrent catalogs sharing one index serialize atomic updates without dropping entries',async()=>{
 const f=await fixture();try{
  const other=new ProjectCatalog({statePath:f.statePath,projectsRoot:f.projectsRoot});const created=await Promise.all(Array.from({length:12},(_,i)=>(i%2?other:f.catalog).create({name:'Paper '+i,template:'blank'})));
  assert.equal(new Set(created.map(project=>project.id)).size,12);const stored=JSON.parse(await fs.readFile(f.statePath,'utf8'));assert.equal(stored.projects.length,12);assert.equal((await f.catalog.list()).projects.length,12);assert.deepEqual((await fs.readdir(f.base)).filter(name=>name.endsWith('.tmp')),[]);
 }finally{await f.cleanup();}
});

test('invalid display names, traversal paths, unknown templates and actions never create projects',async()=>{
 const f=await fixture();try{
  for(const name of ['', '   ','.','..','../paper','a\\b','a/b','x\0y','a'.repeat(121)])await assert.rejects(f.catalog.create({name}),/name/);
  await assert.rejects(f.catalog.create({name:'Okay',template:'__proto__'}),/template/);await assert.rejects(f.catalog.create({name:'Okay',template:'constructor'}),/template/);
  for(const input of ['relative','..',f.base+path.sep+'..'+path.sep+'outside',f.base+'\0bad',path.parse(f.base).root])await assert.rejects(f.catalog.import({path:input}),/folder path|filesystem root/);
  await assert.rejects(f.catalog.handle({action:'delete-everything'}),/Unknown/);await assert.rejects(f.catalog.handle([]),/Invalid/);await assert.rejects(f.catalog.open('missing'),/not found/);assert.equal((await f.catalog.list()).projects.length,0);
 }finally{await f.cleanup();}
});

test('unavailable projects remain listed while open fails without erasing their metadata',async()=>{
 const f=await fixture();try{
  const root=await external(f),project=await f.catalog.import({path:root});await fs.rename(root,root+'-moved');
  const listed=(await f.catalog.list()).projects[0];assert.equal(listed.id,project.id);assert.equal(listed.available,false);assert.equal(listed.root,project.root);await assert.rejects(f.catalog.open(project.id));assert.equal(JSON.parse(await fs.readFile(f.statePath,'utf8')).projects.length,1);
 }finally{await f.cleanup();}
});

test('scanner ignores hidden and build folders and locates non-main independent documents',async()=>{
 const f=await fixture();try{
  const root=await external(f);await fs.mkdir(path.join(root,'section'));await fs.writeFile(path.join(root,'section','intro.tex'),'A fragment');for(const ignored of ['.sidex-realtime','node_modules','target','build']){await fs.mkdir(path.join(root,ignored));await fs.writeFile(path.join(root,ignored,'secret.tex'),'Not a project file');}
  const project=await f.catalog.import({path:root});assert.equal(project.main,'paper.tex');assert.equal(project.texFiles,2);
  const empty=path.join(f.base,'empty');await fs.mkdir(empty);await assert.rejects(f.catalog.import({path:empty}),/no editable/);
 }finally{await f.cleanup();}
});

test('symbolic project roots and redirected registered folders are rejected; nested junctions are never followed',async t=>{
 const f=await fixture();try{
  const outside=await external(f,'outside'),root=await external(f,'inside'),alias=path.join(f.base,'root-link'),nested=path.join(root,'linked');
  try{await fs.symlink(outside,alias,process.platform==='win32'?'junction':'dir');await fs.symlink(outside,nested,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Directory links are not available on this host');return;}throw error;}
  await assert.rejects(f.catalog.import({path:alias}),/symbolic link/);const project=await f.catalog.import({path:root});assert.equal(project.texFiles,1);
  await fs.rename(root,root+'-original');await fs.symlink(outside,root,process.platform==='win32'?'junction':'dir');assert.equal((await f.catalog.list()).projects[0].available,false);await assert.rejects(f.catalog.open(project.id),/symbolic link/);
  const linkedCatalog=new ProjectCatalog({statePath:path.join(f.base,'linked-index.json'),projectsRoot:alias});await assert.rejects(linkedCatalog.create({name:'Do not write outside'}),/symbolic link/);assert.deepEqual(await fs.readdir(outside),['paper.tex']);
 }finally{await f.cleanup();}
});

test('a corrupt index is reported rather than overwritten or used to create orphan projects',async()=>{
 const f=await fixture();try{
  const project=await f.catalog.create({name:'Keep me'}),bad='{"version":1,"projects":[';await fs.writeFile(f.statePath,bad);
  await assert.rejects(f.catalog.list(),/not been overwritten/);await assert.rejects(f.catalog.create({name:'Blocked'}),/not been overwritten/);assert.equal(await fs.readFile(f.statePath,'utf8'),bad);assert.equal((await fs.readdir(f.projectsRoot)).length,1);assert.match(await fs.readFile(path.join(project.root,'main.tex'),'utf8'),/\\documentclass/);
 }finally{await f.cleanup();}
});

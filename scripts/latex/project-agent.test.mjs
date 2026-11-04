import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectWorkspace,runProjectAgent,agentMessages} from './project-agent.mjs';
const fixture=async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'sidex-agent-'));await fs.mkdir(path.join(root,'chapter'));await fs.writeFile(path.join(root,'chapter/one.tex'),'Alpha document.\n');return root;};

test('project tools read/search/edit other chapters, create nested files and preserve unsaved text',async()=>{
 const root=await fixture(),changes=[],workspace=new ProjectWorkspace(root,{documents:[{name:'chapter/one.tex',base:'Alpha document.\n',content:'Alpha unsaved document.\n'}],onChange:change=>changes.push(change)});
 const list=await workspace.invoke('list_files',{});assert(list.files.some(f=>f.path==='chapter/one.tex'));
 const search=await workspace.invoke('search_files',{query:'unsaved'});assert.equal(search.matches[0].path,'chapter/one.tex');
 const read=await workspace.invoke('read_file',{path:'chapter/one.tex'});assert(read.content.includes('unsaved'));
 await workspace.invoke('edit_file',{path:read.path,find:'Alpha',replace:'Beta',expected_sha256:read.sha256});
 assert.equal(await fs.readFile(path.join(root,read.path),'utf8'),'Beta unsaved document.\n');
 await workspace.invoke('write_file',{path:'notes/nested/check.md',content:'Created by agent.'});assert.equal(changes.length,2);
 assert.equal(changes[0].before,'Alpha unsaved document.\n');assert.equal(await fs.readFile(path.join(root,'notes/nested/check.md'),'utf8'),'Created by agent.');
});

test('writes require a fresh read/version and never clobber external changes',async()=>{
 const root=await fixture(),workspace=new ProjectWorkspace(root);await assert.rejects(workspace.invoke('write_file',{path:'chapter/one.tex',content:'Lost'}));
 const read=await workspace.invoke('read_file',{path:'chapter/one.tex'});await fs.writeFile(path.join(root,'chapter/one.tex'),'Alpha external edit.\n');
 await assert.rejects(workspace.invoke('edit_file',{path:read.path,find:'Alpha',replace:'Beta',expected_sha256:read.sha256}));assert.equal(await fs.readFile(path.join(root,read.path),'utf8'),'Alpha external edit.\n');
 await assert.rejects(workspace.invoke('edit_file',{path:'chapter/one.tex',find:'Alpha',replace:'Beta'}));
});

test('project boundary blocks traversal, absolute paths, stream paths and outside junctions',async t=>{
 const root=await fixture(),workspace=new ProjectWorkspace(root);
 for(const name of ['../outside.txt','C:/outside.txt','/outside.txt','chapter/one.tex:secret','.git/config'])await assert.rejects(workspace.invoke('write_file',{path:name,content:'blocked'}),name);
 const outside=await fixture();try{await fs.symlink(outside,path.join(root,'outside-link'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('Symlinks unavailable; direct path boundary checks passed');return;}throw error;}
 await assert.rejects(workspace.invoke('read_file',{path:'outside-link/chapter/one.tex'}));await assert.rejects(workspace.invoke('write_file',{path:'outside-link/new.txt',content:'blocked'}));
});

test('a tool loop performs real cross-file writes and forwards image input to the model',async()=>{
 const root=await fixture(),workspace=new ProjectWorkspace(root),events=[];let round=0;
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
 const fetcher=async(url,options)=>{
  const body=JSON.parse(options.body);assert(body.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.image_url?.url===image)));
  const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});let message;
  if(round++===0)message={role:'assistant',content:null,tool_calls:[call('read','read_file',{path:'chapter/one.tex'})]};
  else if(round===2){const read=JSON.parse(body.messages.find(m=>m.tool_call_id==='read').content);message={role:'assistant',content:null,tool_calls:[call('edit','edit_file',{path:read.path,find:'Alpha',replace:'Beta',expected_sha256:read.sha256}),call('write','write_file',{path:'notes/result.md',content:'Image received.'})]};}
  else message={role:'assistant',content:'Updated chapter and notes.'};return {ok:true,json:async()=>({choices:[{message}]})};
 };
 const result=await runProjectAgent({connection:{baseUrl:'http://localhost:1/v1',model:'mock'},workspace,messages:[{role:'user',content:[{type:'text',text:'Edit the project.'},{type:'image_url',image_url:{url:image}}]}],onEvent:event=>events.push(event),fetcher});
 assert.equal(result.changes.length,2);assert.equal(result.toolCalls,3);assert.equal(await fs.readFile(path.join(root,'chapter/one.tex'),'utf8'),'Beta document.\n');assert(events.some(e=>e.type==='tool-start'&&e.name==='write_file'));
 assert.throws(()=>agentMessages([{role:'user',content:[{type:'image_url',image_url:{url:'http://remote/image.png'}}]}]));
});

test('cancellation and project switching stop subsequent writes',async()=>{
 const root=await fixture(),controller=new AbortController(),workspace=new ProjectWorkspace(root,{signal:controller.signal});controller.abort();await assert.rejects(workspace.invoke('write_file',{path:'new.txt',content:'blocked'}));
 const switched=new ProjectWorkspace(root,{getRoot:()=>path.dirname(root)});await assert.rejects(switched.invoke('read_file',{path:'chapter/one.tex'}));
});

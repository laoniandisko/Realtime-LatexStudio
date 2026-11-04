import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({stdin:{contents:"export * from './src/latex/rtex/source-bindings'; export {UnitAnalyzer} from './src/latex/rtex/analysis-client';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {SourceBindings,rebaseTarget,UnitAnalyzer}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const span=(id,text,from=0,to=text.length,last_revision=1)=>({id,range:{start:Buffer.byteLength(text.slice(0,from)),end:Buffer.byteLength(text.slice(0,to))},last_revision});
const target=(text,selected)=>({file:'paper.tex',from:text.indexOf(selected),to:text.indexOf(selected)+selected.length,text:selected,kind:'paragraph',mode:'text',label:'Paragraph'});

test('changing A never locks an unchanged B drawn at an older global revision',()=>{
 const bindings=new SourceBindings();bindings.install('a.tex','First paragraph',[span(1,'First paragraph')],1);bindings.install('b.tex','Second paragraph',[span(2,'Second paragraph')],1);
 bindings.install('a.tex','First edited paragraph',[span(1,'First edited paragraph',0,22,2)],2);
 bindings.install('b.tex','Second paragraph',[span(2,'Second paragraph')],2);
 assert.equal(bindings.resolve(2,1).file,'b.tex');assert.equal(bindings.resolve(2,1).source,'Second paragraph');
 assert.equal(bindings.resolve(1,1).source,'First paragraph');assert.equal(bindings.resolve(1,2).source,'First edited paragraph');
});

test('a preceding edit rebases an unchanged same-file unit without waiting for pagination',()=>{
 const bindings=new SourceBindings(),before='One.\n\nTwo.',after='A longer first paragraph.\n\nTwo.';
 bindings.install('paper.tex',before,[span(1,before,0,4),span(2,before,6,10)],1);
 bindings.install('paper.tex',after,[span(1,after,0,25,2),span(2,after,27,31)],2);
 const binding=bindings.resolve(2,1);assert.equal(binding.source.slice(binding.from,binding.to),'Two.');
 const next=rebaseTarget(target(before,'Two.'),before,after);assert.equal(next.text,'Two.');assert.equal(after.slice(next.from,next.to),'Two.');
});

test('unfinished LaTeX inside a selected paragraph stays editable',()=>{
 const before='Before.\n\nA complete paragraph.\n\nAfter.',after=before.replace('complete','\\frac{unfinished');
 const next=rebaseTarget(target(before,'A complete paragraph.'),before,after);
 assert(next);assert.equal(next.text,'A \\frac{unfinished paragraph.');assert.equal(next.mode,'latex');
});

test('several outside edits preserve exact unique targets and reject ambiguous crossed targets',()=>{
 const before='Start\n\nKeep this paragraph.\n\nEnd',after='A new start\n\nKeep this paragraph.\n\nA new ending';
 const next=rebaseTarget(target(before,'Keep this paragraph.'),before,after);assert.equal(next.text,'Keep this paragraph.');assert.equal(next.from,after.indexOf('Keep'));
 assert.equal(rebaseTarget(target('xx repeat yy repeat zz','repeat'),'xx repeat yy repeat zz','repeat repeat'),null);
});

test('UTF-8 source bindings preserve non-ASCII text and stale targets reject wrong snapshots',()=>{
 const bindings=new SourceBindings(),text='前言\n\n中文段落。';bindings.install('paper.tex',text,[span(7,text,4)],1);const binding=bindings.resolve(7,1);assert.equal(binding.source.slice(binding.from),'中文段落。');
 assert.equal(rebaseTarget({...target(text,'中文段落。'),text:'different'},text,text),null);
});

test('unchanged visual units reuse analysis when another paragraph gets new rows',async()=>{
 const analyzer=new UnitAnalyzer(),rows=[];
 const first=analyzer.analyze(1,rows,'Paragraph');const same=analyzer.analyze(1,[...rows],'Paragraph');assert.equal(first,same);await first;
 const changed=analyzer.analyze(1,rows,'Edited paragraph');assert.notEqual(changed,first);await changed;analyzer.reset();
});

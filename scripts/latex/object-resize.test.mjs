import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {resizeGraphicAxes,resizeTable,objectRegions,tableSetting} from './src/latex/rtex/object-edit';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {resizeGraphicAxes,resizeTable,objectRegions,tableSetting}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const size={widthBp:200,heightBp:80};
const body=String.raw`\begin{tabular}{lc}\toprule
Method & $x^2$ \\
A & 0.9 \\
\bottomrule\end{tabular}`;
const table=String.raw`\begin{table}[t]
\centering
${body}
\caption{Keep \emph{this} caption}\label{tab:keep}
\end{table}`;

test('an image side handle changes one axis and preserves crop, path and original dimensions units',()=>{
 const source='\\includegraphics[width=.5\\linewidth,trim={1 2 3 4},clip]{figs/a.pdf}';
 const wider=resizeGraphicAxes(source,{x:1.2,y:1},size);
 assert.equal(wider,'\\includegraphics[trim={1 2 3 4},clip,width=0.6\\linewidth,height=80bp,keepaspectratio=false]{figs/a.pdf}');
 const taller=resizeGraphicAxes('\\includegraphics[height=6cm,clip]{a.pdf}',{x:1,y:1.5},size);
 assert(taller.includes('width=200bp,height=9cm'));assert(taller.endsWith('{a.pdf}'));
});
test('non-uniform image resize overrides bounding-box aspect constraints and applies scale only once',()=>{
 const source='\\includegraphics[width=.8\\linewidth,height=6cm,keepaspectratio=true,scale=.9,angle=0]{a.pdf}';
 const resized=resizeGraphicAxes(source,{x:1.5,y:.75},size);
 assert(resized.includes('scale=.9,angle=0,width=300bp,height=60bp,keepaspectratio=false'));
 assert.equal((resized.match(/scale=/g)||[]).length,1);assert.equal((resized.match(/keepaspectratio=/g)||[]).length,1);
});
test('repeated independent image drags update the same options instead of accumulating wrappers or size keys',()=>{
 const first=resizeGraphicAxes('\\includegraphics*[width=100bp,height=40bp]{a.pdf}',{x:2,y:.5},{widthBp:100,heightBp:40});
 const second=resizeGraphicAxes(first,{x:.5,y:3},{widthBp:200,heightBp:20});
 assert(second.startsWith('\\includegraphics*['));assert(second.includes('width=100bp,height=60bp'));assert.equal((second.match(/width=/g)||[]).length,1);assert.equal((second.match(/height=/g)||[]).length,1);
});
test('uniform corners keep existing image behavior, while dynamic sizing and rotated independent axes reject safely',()=>{
 const rotated='\\includegraphics[width=8cm,angle=15,clip]{a.pdf}';
 assert(resizeGraphicAxes(rotated,{x:.5,y:.5},size).includes('width=4cm,angle=15,clip'));
 assert.throws(()=>resizeGraphicAxes(rotated,{x:2,y:1},size),/旋转/);
 assert.throws(()=>resizeGraphicAxes('\\includegraphics[width=\\customwidth]{a.pdf}',{x:2,y:1},size),/自定义宏/);
 assert.throws(()=>resizeGraphicAxes(rotated,{x:0,y:1},size),/范围/);
});
test('new table scaling wraps only the tabular and keeps caption and label bytes outside',()=>{
 const result=resizeTable(table,{x:1.2,y:.8},size);
 assert(result.requiresGraphicx);assert(result.text.includes('\\scalebox{1.2}[0.8]{'+body+'}'));
 assert(result.text.includes('}\n\\caption{Keep \\emph{this} caption}\\label{tab:keep}'));
 assert.equal((result.text.match(/\\scalebox/g)||[]).length,1);
});
test('repeated table resizing multiplies an existing outer scalebox without nesting again',()=>{
 const first=resizeTable(table,{x:1.2,y:.8},size).text;
 const second=resizeTable(first,{x:.5,y:1.5},{widthBp:240,heightBp:64}).text;
 assert(second.includes('\\scalebox{0.6}[1.2]{'+body+'}'));assert.equal((second.match(/\\scalebox/g)||[]).length,1);assert(second.includes('\\label{tab:keep}'));
});
test('a template-relative resizebox is reused for proportional drags and fixed independent dimensions',()=>{
 const sized=table.replace(body,'\\resizebox{\\linewidth}{!}{'+body+'}');
 const uniform=resizeTable(sized,{x:.75,y:.75},size).text;
 assert(uniform.includes('\\resizebox{0.75\\linewidth}{!}{'+body+'}'));assert(!uniform.includes('\\scalebox'));
 const fixed=table.replace(body,'\\resizebox*{10cm}{4cm}{'+body+'}');
 const axes=resizeTable(fixed,{x:1.2,y:.5},size).text;
 assert(axes.includes('\\resizebox*{12cm}{2cm}{'+body+'}'));assert(!axes.includes('\\scalebox'));
});
test('a resizebox with a natural axis gains at most one reusable scale wrapper for independent stretching',()=>{
 const original=table.replace(body,'\\resizebox{\\textwidth}{!}{'+body+'}');
 const first=resizeTable(original,{x:1.25,y:.8},size).text;
 assert(first.includes('\\scalebox{1.25}[0.8]{\\resizebox{\\textwidth}{!}{'+body+'}}'));
 const second=resizeTable(first,{x:1,y:1.5},{widthBp:250,heightBp:64}).text;
 assert(second.includes('\\scalebox{1.25}[1.2]'));assert.equal((second.match(/\\scalebox/g)||[]).length,1);assert.equal((second.match(/\\resizebox/g)||[]).length,1);assert(second.includes('\\caption{Keep \\emph{this} caption}'));
});
test('table resize rejects ambiguous/multi-page wrappers and caption-containing existing scale boxes',()=>{
 assert.throws(()=>resizeTable('\\begin{longtable}{cc}A&B\\\\\\end{longtable}',{x:1.2,y:1},size),/多页/);
 assert.throws(()=>resizeTable(table.replace(body,body+'\n'+body),{x:1.2,y:1},size),/一个完整/);
 assert.throws(()=>resizeTable('\\resizebox{\\customwidth}{!}{'+body+'}',{x:1.2,y:1.2},size),/自定义宏/);
 assert.throws(()=>resizeTable('\\scalebox{1}{'+body+'\\caption{Bad}\\label{x}}',{x:1.2,y:1},size),/标题或标签/);
 assert.throws(()=>resizeTable('\\rotatebox{30}{'+body+'}',{x:1.2,y:1},size),/版式命令/);
});
test('table object bounds follow PDF scale matrices and exclude captions in the same capture row',()=>{
 const sp=65781.76,source='\\begin{table}\\begin{tabular}{cc}A & B \\\\ \\end{tabular}\\caption{CaptionC}\\end{table}',a=source.indexOf('A &'),b=source.indexOf('B \\'),c=source.indexOf('CaptionC');
 const rows=[{page:1,dx:0,dy:0,dl:{fonts:{0:{size:10*sp}}},line:{items:[['M','save',100*sp,200*sp,''],['M','set',100*sp,200*sp,'.5 0 0 .5'],['r',95*sp,189*sp,70*sp,sp],['g',0,65,null,100*sp,200*sp,8*sp],['g',0,66,null,150*sp,200*sp,8*sp],['M','restore',100*sp,200*sp,''],['g',0,67,null,100*sp,250*sp,8*sp]]}}];
 const chars=[{page:1,line:0,x:100*sp,y:192*sp,w:8*sp,h:10*sp,from:a,to:a+1},{page:1,line:0,x:150*sp,y:192*sp,w:8*sp,h:10*sp,from:b,to:b+1},{page:1,line:0,x:100*sp,y:242*sp,w:8*sp,h:10*sp,from:c,to:c+1}];
 const object=objectRegions(rows,source,chars).find(o=>o.kind==='table');assert(object);assert(Math.abs(object.x/sp-97.5)<1e-6);assert(Math.abs(object.w/sp-35)<1e-6);assert((object.y+object.h)/sp<210,'Caption must stay outside the resize frame');
});
test('a bare tabular mapping retains its outer scale wrapper for the second resize',()=>{
 const bare='\\begin{tabular}{c}UniqueCell\\\\\\end{tabular}',first=resizeTable(bare,{x:1.2,y:1.2},size).text;
 const at=first.indexOf('UniqueCell'),sp=65781.76,rows=[{page:1,dx:0,dy:0,dl:{fonts:{0:{size:10*sp}}},line:{items:[['g',0,85,null,100*sp,100*sp,8*sp]]}}],chars=[{page:1,line:0,x:100*sp,y:92*sp,w:8*sp,h:10*sp,from:at,to:at+1}];
 const object=objectRegions(rows,first,chars).find(o=>o.kind==='table');assert(object);assert.equal(object.target.from,0);assert.equal(object.target.to,first.length);assert.equal(object.target.text,first);
 const second=resizeTable(object.target.text,{x:.5,y:1.25},size).text;assert(second.includes('\\scalebox{0.6}[1.5]'));assert.equal((second.match(/\\scalebox/g)||[]).length,1);assert(second.includes(bare));
});
test('a resized bare table still accepts local spacing changes without discarding its scale',()=>{
 const bare='\\begin{tabular}{c}Cell\\\\\\end{tabular}',scaled=resizeTable(bare,{x:1.2,y:.8},size).text;
 const next=tableSetting(tableSetting(scaled,'columns',8),'rows',1.1);
 assert(next.startsWith('\\scalebox{1.2}[0.8]{'));assert(next.includes('\\setlength{\\tabcolsep}{8pt}'));assert(next.includes('\\renewcommand{\\arraystretch}{1.1}'));assert(next.includes(bare));
 const again=resizeTable(next,{x:.5,y:1},size).text;assert(again.includes('\\scalebox{0.6}[0.8]'));assert(again.includes('\\setlength{\\tabcolsep}{8pt}'));
});

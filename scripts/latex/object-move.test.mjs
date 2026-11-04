import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './src/latex/rtex/object-move';export {paragraphTarget} from './src/latex/rtex/block-edit';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {objectMoveTarget,moveObject,paragraphTarget}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const file=(content,name='main.tex')=>({name,content});
const hit=(source,text,name='main.tex')=>({file:name,from:source.indexOf(text),to:source.indexOf(text)+text.length,text,kind:'source',mode:'latex',label:'object'});
const prose=(source,needle,name='main.tex')=>({...paragraphTarget(source,source.indexOf(needle)),file:name});
const picture=String.raw`\begin{figure}[t]
\centering
\includegraphics[width=.8\linewidth,trim={1 2 3 4},clip]{a.pdf}
\caption{Caption with \emph{formatting} and $x^2$.}\label{fig:keep}
\end{figure}`;
const table=String.raw`\begin{table*}[tp]
\centering
\begin{tabular}{lc}a & b \\ c & $x$ \\\end{tabular}
\caption{Keep table caption.}\label{tab:keep}
\end{table*}`;

test('an image hit promotes to the whole figure, including caption, label and dimensions',()=>{
 const source='Before.\n\n'+picture+'\n\nAfter.',graphic='\\includegraphics[width=.8\\linewidth,trim={1 2 3 4},clip]{a.pdf}',target=objectMoveTarget(file(source),hit(source,graphic));
 assert.equal(target.text,picture);assert.equal(target.from,source.indexOf('\\begin{figure}'));assert.equal(target.to,source.indexOf('\\end{figure}')+12);
 const next=moveObject([file(source)],hit(source,graphic),prose(source,'After.'),true)[0].after;
 assert(next.indexOf('After.')<next.indexOf('\\begin{figure}'));assert(next.endsWith(picture));assert.equal(next.match(/fig:keep/g).length,1);assert(next.includes(picture));
});
test('table hits and figure destinations normalize complete outer floats, never inserting into captions',()=>{
 const source='First.\n\n'+picture+'\n\n'+table+'\n\nLast.',cell='\\begin{tabular}{lc}a & b \\\\ c & $x$ \\\\\\end{tabular}',destination=hit(source,'\\includegraphics[width=.8\\linewidth,trim={1 2 3 4},clip]{a.pdf}');
 const normalized=objectMoveTarget(file(source),hit(source,cell));assert.equal(normalized.text,table);
 const next=moveObject([file(source)],normalized,destination,false)[0].after;
 assert(next.indexOf('\\begin{table*}')<next.indexOf('\\begin{figure}'));assert(next.includes(picture));assert(next.includes(table));assert(next.includes('\\label{tab:keep}'));assert(next.endsWith('Last.'));
});
test('paragraphs can also be moved to complete object boundaries',()=>{
 const source='First paragraph.\n\n'+picture+'\n\nLast paragraph.',first=prose(source,'First paragraph.');
 assert.deepEqual(objectMoveTarget(file(source),first),first);
 const next=moveObject([file(source)],first,hit(source,'\\caption{Caption with \\emph{formatting} and $x^2$.}'),true)[0].after;
 assert(next.indexOf('\\end{figure}')<next.indexOf('First paragraph.'));assert(next.includes(picture));assert(next.endsWith('Last paragraph.'));
});
test('cross-file moves return exact two-file snapshots and preserve complete source bytes',()=>{
 const a='Before.\n\n'+picture+'\n\nStay.',b='Destination.\n\n'+table;
 const changes=moveObject([file(a,'a.tex'),file(b,'b.tex')],hit(a,picture,'a.tex'),hit(b,table,'b.tex'),true);
 assert.equal(changes.length,2);assert.equal(changes[0].before,a);assert.equal(changes[1].before,b);assert.equal(changes[0].after,'Before.\n\nStay.');assert(changes[1].after.endsWith(table+'\n\n'+picture));
});
test('nearby placement is explicit and keeps single/double-column semantics and caption content',()=>{
 const source='Before.\n\n'+picture+'\n\n'+table+'\n\nLast.';
 const single=moveObject([file(source)],hit(source,picture),prose(source,'Last.'),true,{placement:'near'})[0].after;
 assert(single.includes('\\begin{figure}[!htbp]'));assert(single.includes('\\caption{Caption with \\emph{formatting} and $x^2$.}\\label{fig:keep}'));
 const double=moveObject([file(source)],hit(source,table),prose(source,'Before.'),false,{placement:'near'})[0].after;
 assert(double.startsWith('\\begin{table*}[!tp]'));assert(double.includes('\\label{tab:keep}'));assert(!double.includes('[H]'));
 const commented=picture.replace('\\begin{figure}[t]','\\begin{figure}% preserve this comment\n[t]'),document='Before.\n\n'+commented+'\n\nAfter.';
 const preserved=moveObject([file(document)],hit(document,commented),prose(document,'Before.'),false,{placement:'near'})[0].after;
 assert(preserved.startsWith('\\begin{figure}% preserve this comment\n[!htbp]'));assert(!preserved.includes('\n[t]'));
});
test('bare top-level tabular moves as a complete balanced block',()=>{
 const bare='\\begin{tabular}{ll}a & b \\\\ c & d \\\\\\end{tabular}',source='Before.\n\n'+bare+'\n\nAfter.';
 const next=moveObject([file(source)],hit(source,bare),prose(source,'Before.'),false)[0].after;
 assert(next.startsWith(bare+'\n\n'));assert(next.includes('Before.'));assert(next.endsWith('After.'));
});
test('a bare table cannot leave an adjacent external caption or label behind',()=>{
 const bare='\\begin{tabular}{ll}a & b \\\\ c & d \\\\\\end{tabular}';
 for(const bound of [
  bare+'\n\\captionof{table}{Keep below.}\\label{tab:external}',
  '\\captionof{table}[Short]{Keep \\emph{above}.}\n\\label{tab:external}\n'+bare,
  bare+'\n% attached metadata\n\\smallskip\n\\label{tab:external}',
  '\\label{tab:external}\n\\setlength{\\tabcolsep}{4pt}\n'+bare,
  bare+'\n{\\small\n\\captionof{table}{Grouped external caption.}}',
  '\\begin{center}\n'+bare+'\n\\captionof{table}{Centered caption.}\\end{center}'
 ]){
  const source='Before.\n\n'+bound+'\n\nAfter.';
  assert.throws(()=>objectMoveTarget(file(source),hit(source,bare)),/外部标题、标签或布局环境绑定/);
  assert.throws(()=>moveObject([file(source)],hit(source,bare),prose(source,'After.'),true),/外部标题、标签或布局环境绑定/);
  assert.throws(()=>moveObject([file(source)],prose(source,'Before.'),hit(source,bare),true),/外部标题、标签或布局环境绑定/);
 }
});
test('full floating tables keep external-to-tabular captions and unrelated metadata does not disable an independent bare table',()=>{
 const bare='\\begin{tabular}{ll}a & b \\\\ c & d \\\\\\end{tabular}',floating='\\begin{table}[t]\n'+bare+'\n\\captionof{table}{Inside full table.}\\label{tab:inside}\n\\end{table}',source='Before.\n\n'+floating+'\n\nAfter.';
 const normalized=objectMoveTarget(file(source),hit(source,bare));assert.equal(normalized.text,floating);const moved=moveObject([file(source)],normalized,prose(source,'After.'),true)[0].after;assert(moved.endsWith(floating));
 const independent='\\section{Earlier}\\label{sec:earlier}\n\nA real prose paragraph separates the section metadata.\n\n'+bare+'\n\nAfter.\n\n'+picture;
 assert.equal(objectMoveTarget(file(independent),hit(independent,bare)).text,bare);
});
test('title macro/preamble figures and inline images cannot be detached into the document body',()=>{
 const teaser='\\documentclass{article}\n\\makeatletter\n\\g@addto@macro\\@maketitle{\\includegraphics{teaser.pdf}}\n\\makeatother\n\\begin{document}\nBody.\n\\end{document}';
 assert.throws(()=>objectMoveTarget(file(teaser),hit(teaser,'\\includegraphics{teaser.pdf}')),/导言区或标题宏/);
 assert.throws(()=>moveObject([file(teaser)],hit(teaser,'\\includegraphics{teaser.pdf}'),prose(teaser,'Body.'),true),/导言区或标题宏/);
 const inline='Before \\includegraphics{icon.pdf} after.\n\nLast.';assert.throws(()=>objectMoveTarget(file(inline),hit(inline,'\\includegraphics{icon.pdf}')),/特殊结构/);
 const macro='\\newcommand{\\foo}{'+picture+'}\n\nOutside.';assert.throws(()=>objectMoveTarget(file(macro),hit(macro,picture)),/宏参数或局部分组/);
});
test('stale snippets, partial paragraphs, nested overlaps and protected scope crossings are rejected',()=>{
 const source='Root.\n\n'+picture+'\n\n\\begin{abstract}\nInside.\n\\end{abstract}\n\nLast.',object=hit(source,picture);
 assert.throws(()=>moveObject([file(source.replace('a.pdf','changed.pdf'))],object,prose(source,'Root.'),false),/改变/);
 assert.throws(()=>moveObject([file(source)],object,prose(source,'Inside.'),true),/边界/);
 const partial={...prose(source,'Root.'),to:2,text:'Ro'};assert.throws(()=>moveObject([file(source)],object,partial,true),/完整正文段落/);
 assert.deepEqual(moveObject([file(source)],object,hit(source,'\\includegraphics[width=.8\\linewidth,trim={1 2 3 4},clip]{a.pdf}'),false),[]);
 const grouped='{\\small\n\n'+picture+'\n\n}\n\nOutside.';assert.throws(()=>moveObject([file(grouped)],hit(grouped,picture),prose(grouped,'Outside.'),true),/局部分组/);
});
test('comments, verbatim and escaped fake environment names never become movable objects',()=>{
 const source='% \\begin{figure}fake\\end{figure}\n\\verb|\\begin{table}|\n\\begin{verbatim}\n{ \\begin{figure}fake\\end{figure}\n\\end{verbatim}\n\n'+picture+'\n\nAfter.';
 const object=objectMoveTarget(file(source),hit(source,picture));assert.equal(object.text,picture);
 const next=moveObject([file(source)],object,prose(source,'After.'),true)[0].after;assert(next.endsWith(picture));assert(next.includes('\\begin{verbatim}\n{ \\begin{figure}fake\\end{figure}'));
 assert.throws(()=>objectMoveTarget(file(source),hit(source,'fake')),/特殊结构/);
});
test('conditional branches and list items remain protected boundaries',()=>{
 const source='\\iftrue\n\n'+picture+'\n\n\\else\n\nOther branch.\n\n\\fi\n\nEnd.';
 assert.throws(()=>moveObject([file(source)],hit(source,picture),prose(source,'Other branch.'),false),/条件分支/);
 const source2='\\begin{itemize}\n\\item '+picture+'\n\\item Other item.\n\\end{itemize}';assert.throws(()=>moveObject([file(source2)],hit(source2,picture),prose(source2,'Other item.'),false),/列表/);
});
test('newif declarations are not treated as active conditional branches in later cross-file moves',()=>{
 const source='\\newif\\ifdraft\n\\draftfalse\n\\begin{document}\n\n'+picture+'\n\n\\end{document}',destination='Destination paragraph.';
 const changes=moveObject([file(source,'a.tex'),file(destination,'b.tex')],hit(source,picture,'a.tex'),prose(destination,'Destination','b.tex'),true);
 assert.equal(changes.length,2);assert(changes[0].after.includes('\\newif\\ifdraft'));assert(changes[1].after.endsWith(picture));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './src/latex/rtex/format-guard';export * from './src/latex/diagnostics';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {formattingIssue,parseCompileProblems}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('a prose deletion cannot turn emphasis and adjacent text into an undefined command',()=>{
 const before='changes that remove a source of \\emph{global} geometric bias.';
 assert(formattingIssue(before,'changes that remove a source of \\emphric bias.'));
 assert(formattingIssue(before,'Other changes remove a source of \\emphric bias.'));
 assert(formattingIssue(before,'changes that remove a source of \\emph{global geometric bias.'));
});
test('normal paragraph edits, complete replacements, and valid formatting changes remain editable',()=>{
 const before='A \\emph{global} geometric bias.';
 for(const after of ['A \\emph{local} geometric bias.','A \\emph{} geometric bias.','A geometric bias.','A different paragraph.','A \\textbf{global} geometric bias.'])assert.equal(formattingIssue(before,after),null,after);
});
test('nested formatting guards preserve the inner command and escaped braces',()=>{
 assert(formattingIssue('A \\textbf{very \\emph{important}} result.','A \\textbf{very \\emphimportant} result.'));
 assert.equal(formattingIssue('A \\emph{\\{x\\}} result.','A \\emph{\\{y\\}} result.'),null);
});
test('compiler diagnostics identify the actual included file and deduplicate fatal summaries',()=>{
 const log='./section/02related-work.tex:7: Undefined control sequence.\nl.7 source of \\emphric bias.\n! ==> Fatal error occurred, no output PDF file produced!';
 assert.deepEqual(parseCompileProblems(log,'main.tex',['main.tex','section/02related-work.tex']),[{file:'section/02related-work.tex',line:7,message:'Undefined control sequence.'}]);
});
test('compiler paths support nested mains and Windows paths without inventing main-file errors',()=>{
 const files=['Anonymous/LaTeX/main.tex','Anonymous/LaTeX/section/intro.tex'];
 assert.equal(parseCompileProblems('./section/intro.tex:4: Missing $ inserted.','Anonymous/LaTeX/main.tex',files)[0].file,files[1]);
 assert.equal(parseCompileProblems('C:\\paper\\Anonymous\\LaTeX\\section\\intro.tex:4: Missing $ inserted.','main.tex',files)[0].file,files[1]);
 assert.equal(parseCompileProblems('! Undefined control sequence.\nl.7 bad','main.tex',files)[0].file,undefined);
});

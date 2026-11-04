export interface CompileProblem {message:string;file?:string;line?:number}
export function parseCompileProblems(log:string,main:string,files:readonly string[]=[]):CompileProblem[]{
  const out:CompileProblem[]=[],lines=log.split(/\r?\n/),base=main.replace(/\\/g,'/').replace(/[^/]+$/,'');
  for(let i=0;i<lines.length;i++){
    const located=/^(.+?\.(?:tex|sty|cls)):(\d+):\s*(.+)$/.exec(lines[i]);
    if(located){
      const path=located[1].replace(/\\/g,'/').replace(/^\.\//,''),relative=base+path;
      const file=files.find(f=>f===relative)||files.find(f=>f===path)||files.find(f=>path.endsWith('/'+f))||path;
      const problem={file,line:Number(located[2]),message:located[3].trim()};
      if(!out.some(e=>e.file===problem.file&&e.line===problem.line&&e.message===problem.message))out.push(problem);
    }else if(lines[i].startsWith('!')){
      const message=lines[i].slice(1).trim();
      if(/Fatal error|no output PDF/i.test(message)&&out.length)continue;
      const next=lines.slice(i+1,i+12).join('\n').match(/(?:^|\n)l\.(\d+)/);
      if(!out.some(e=>e.message===message&&e.line===(next?Number(next[1]):undefined)))out.push({message,line:next?Number(next[1]):undefined});
    }
  }
  return out;
}

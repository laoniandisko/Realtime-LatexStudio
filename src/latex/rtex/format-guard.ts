const formatting=/\\(?:emph|textbf|textit|texttt|textsf|textrm|textsc|textsl|textup|textnormal|underline)\s*\{/g;
function groupEnd(source:string,open:number){
  let depth=0;
  for(let i=open;i<source.length;i++){
    if(source[i]==='\\'){i++;continue;}
    if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)return -1;i=end;continue;}
    if(source[i]==='{')depth++;
    if(source[i]==='}'&&--depth===0)return i+1;
  }
  return -1;
}
/** Prose edits may remove complete formatting nodes, but cannot splice their commands. */
export function formattingIssue(before:string,after:string):string|null {
  if(before===after)return null;
  for(const match of after.matchAll(/\\(?:emph|textbf|textit|texttt|textsf|textrm|textsc|textsl|textup|textnormal|underline)[A-Za-z]+/g)) {
    if(!before.includes(match[0]))return '格式命令不能与正文拼接；请编辑花括号内的文字。';
  }
  let from=0,to=before.length,nextTo=after.length;
  while(from<to&&from<nextTo&&before[from]===after[from])from++;
  while(to>from&&nextTo>from&&before[to-1]===after[nextTo-1]){to--;nextTo--;}
  for(const match of before.matchAll(formatting)){
    const start=match.index!,open=start+match[0].length-1,end=groupEnd(before,open);if(end<0)continue;
    if(to<=start||from>=end)continue;
    if(from<=start&&to>=end)continue;
    if(from>open&&to<end)continue;
    const at=from<start?start+(nextTo-to):start;
    const replacement=/^\\(?:emph|textbf|textit|texttt|textsf|textrm|textsc|textsl|textup|textnormal|underline)\s*\{/.exec(after.slice(at));
    if(!replacement||groupEnd(after,at+replacement[0].length-1)<0)return '格式命令受保护：请编辑花括号内的文字；修改格式请使用左侧源码。';
  }
  return null;
}

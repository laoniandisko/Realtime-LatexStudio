import { paragraphTarget, type BlockTarget } from './block-edit';
import type { SourceFile } from '../source-map';

export interface FileChange { file: string; before: string; after: string }
export function moveScopeAt(source: string, offset: number) {
  const stack: string[] = [];
  for (let i=0;i<offset;i++) {
    if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)break;i=end;continue;}
    if(source[i]==='\\'){
      const env=/^\\(begin|end)\{([^}]+)\}/.exec(source.slice(i));
      if(env){if(env[2]!=='document'){if(env[1]==='begin')stack.push(`env:${env[2]}@${i}`);else {if(stack.at(-1)?.startsWith('item@'))stack.pop();if(!stack.pop()?.startsWith(`env:${env[2]}@`))throw Error('环境边界不完整，请在源码中移动。');}}i+=env[0].length-1;continue;}
      const item=/^\\item\b(?:\[[^\]]*\])?/.exec(source.slice(i));
      if(item&&stack.some(entry=>/^env:(?:itemize|enumerate|description)@/.test(entry))){if(stack.at(-1)?.startsWith('item@'))stack.pop();stack.push(`item@${i}`);i+=item[0].length-1;continue;}
      const verb=/^\\verb\*?(.)/.exec(source.slice(i));if(verb){const end=source.indexOf(verb[1],i+verb[0].length);i=end<0?offset:end;continue;}
      if(!/[A-Za-z@]/.test(source[i+1]||''))i++;
      continue;
    }
    if(source[i]==='{')stack.push(`group@${i}`);
    if(source[i]==='}'&&!stack.pop()?.startsWith('group@'))throw Error('分组边界不完整，请在源码中移动。');
  }
  return stack;
}
function verify(file: SourceFile, target: BlockTarget) {
  if(target.kind!=='paragraph'||file.content.slice(target.from,target.to)!==target.text)throw Error('段落已改变，请重新拖动。');
  const canonical=paragraphTarget(file.content,target.from);
  if(!canonical||canonical.kind!=='paragraph'||canonical.from!==target.from||canonical.to!==target.to)throw Error('仅可移动完整正文段落，结构块请在源码中调整。');
  const start=moveScopeAt(file.content,target.from),end=moveScopeAt(file.content,target.to);
  if(start.join('/')!==end.join('/'))throw Error('段落包含未闭合结构，不能移动。');
  return start;
}

/** A source transaction. Floats, section commands and environment boundaries are never flattened. */
export function moveParagraph(files: SourceFile[], source: BlockTarget, destination: BlockTarget, after: boolean): FileChange[] {
  const a=files.find(f=>f.name===source.file),b=files.find(f=>f.name===destination.file);
  if(!a||!b)throw Error('找不到段落所在文件。');
  const aScope=verify(a,source),bScope=verify(b,destination);
  if(aScope.join('/')!==bScope.join('/')||(a.name!==b.name&&(aScope.length||bScope.length)))throw Error('不能跨越摘要、列表或局部分组边界移动。');
  if(a.name===b.name&&source.from===destination.from)return [];
  let from=source.from,to=source.to;
  const following=/^[\t \r]*\n[\t \r]*\n/.exec(a.content.slice(to));
  if(following)to+=following[0].length;
  else {const preceding=/\n[\t \r]*\n[\t \r]*$/.exec(a.content.slice(0,from));if(preceding)from-=preceding[0].length;}
  const at=after?destination.to:destination.from,insertion=after?'\n\n'+source.text:source.text+'\n\n';
  const removed=a.content.slice(0,from)+a.content.slice(to);
  if(a.name===b.name){
    if(at>from&&at<to)return [];
    const point=at>=to?at-(to-from):at;
    const next=removed.slice(0,point)+insertion+removed.slice(point);
    return next===a.content?[]:[{file:a.name,before:a.content,after:next}];
  }
  return [{file:a.name,before:a.content,after:removed},{file:b.name,before:b.content,after:b.content.slice(0,at)+insertion+b.content.slice(at)}];
}

import { paragraphTarget, type BlockTarget } from './block-edit';
import type { SourceFile } from '../source-map';
import { moveScopeAt, type FileChange } from './paragraph-move';

interface Environment { name: string; from: number; beginTo: number; endFrom: number; to: number }
interface Scan { environments: Environment[]; masked: string; commands: {name: string; at: number}[] }
const floats = /^(?:figure|table)\*?$/;
const tables = /^tabular(?:\*|x)?$/;
const literals = /^(?:verbatim\*?|Verbatim|lstlisting|minted|comment)$/;
const macroCondition = /^(?:ifthenelse|ifstrequal|ifstrempty|ifblank|ifdef|ifcsdef|ifboolexpr)$/;

/** Ignore comments and verbatim content while locating balanced environment nodes. */
function scan(source: string): Scan {
  const stack: {name: string; from: number; beginTo: number}[] = [], environments: Environment[] = [], commands: Scan['commands'] = [];
  const chars=source.split('');
  const mask=(from:number,to:number)=>{for(let i=from;i<to;i++)if(chars[i]!=='\n'&&chars[i]!=='\r')chars[i]=' ';};
  for(let i=0;i<source.length;){
    if(source[i]==='%'){const end=source.indexOf('\n',i),to=end<0?source.length:end;mask(i,to);i=to;continue;}
    if(source[i]!=='\\'){i++;continue;}
    const command=/^\\([A-Za-z@]+)\*?/.exec(source.slice(i));
    if(!command){i+=2;continue;}
    const name=command[1],at=i;
    if(name==='newif'||/^(?:def|gdef|edef|xdef)$/.test(name)){
      // The following control sequence is being declared, not executed as an if.
      let next=i+command[0].length;while(/\s/.test(source[next]||'')&&next<source.length)next++;
      const declared=/^\\(?:[A-Za-z@]+|.)/.exec(source.slice(next));
      if(declared){i=next+declared[0].length;continue;}
    }
    if(name==='verb'){
      const delimiter=source[i+command[0].length],end=source.indexOf(delimiter,i+command[0].length+1);
      if(!delimiter||end<0)throw Error('逐字文本边界不完整，请在源码中移动。');
      i=end+1;mask(at,i);continue;
    }
    if(name==='string'){
      let next=i+command[0].length;while(/[\t ]/.test(source[next]||''))next++;
      const literal=/^\\(?:[A-Za-z@]+|.)/.exec(source.slice(next));i=next+(literal?.[0].length||1);mask(at,i);continue;
    }
    const environment=/^\\(begin|end)\s*\{\s*([^{}]+?)\s*\}/.exec(source.slice(i));
    if(environment){
      const end=i+environment[0].length,env=environment[2];
      if(environment[1]==='begin'&&literals.test(env)){
        const close=new RegExp('\\\\end\\s*\\{\\s*'+env.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\}','g');close.lastIndex=end;
        const match=close.exec(source);if(!match)throw Error('逐字环境边界不完整，请在源码中移动。');
        i=match.index+match[0].length;mask(at,i);continue;
      }
      if(environment[1]==='begin')stack.push({name:env,from:i,beginTo:end});
      else {const open=stack.pop();if(!open||open.name!==env)throw Error('环境边界不完整，请在源码中移动。');environments.push({...open,endFrom:i,to:end});}
      i=end;continue;
    }
    commands.push({name,at});i+=command[0].length;
  }
  if(stack.length)throw Error('环境边界不完整，请在源码中移动。');
  return {environments,masked:chars.join(''),commands};
}

function exact(file: SourceFile, target: BlockTarget) {
  if(target.file!==file.name||!Number.isInteger(target.from)||!Number.isInteger(target.to)||target.from<0||target.to<=target.from||target.to>file.content.length||file.content.slice(target.from,target.to)!==target.text)throw Error('图表或落点内容已改变，请重新拖动。');
}
function body(scan: Scan, target: BlockTarget) {
  const document=scan.environments.find(env=>env.name==='document');
  if(document&&(target.from<document.beginTo||target.to>document.endFrom))throw Error('此图表位于导言区或标题宏，不能拖到正文；请在源码中调整位置。');
}
function scope(scan: Scan, offset: number) {
  const context=moveScopeAt(scan.masked,offset),conditionals: {name:string;at:number;branch:number}[]=[];
  for(const command of scan.commands){
    if(command.at>=offset)break;
    if(/^if[A-Za-z]*$/.test(command.name)&&!macroCondition.test(command.name))conditionals.push({name:command.name,at:command.at,branch:0});
    else if(command.name==='else'||command.name==='or'){const current=conditionals.at(-1);if(!current)throw Error('条件分支边界不完整，请在源码中移动。');current.branch++;}
    else if(command.name==='fi'&&!conditionals.pop())throw Error('条件分支边界不完整，请在源码中移动。');
  }
  return context.concat(conditionals.map(c=>`${c.name}@${c.at}:${c.branch}`));
}
function completeScope(scan: Scan, target: BlockTarget) {
  const start=scope(scan,target.from),end=scope(scan,target.to);
  if(start.join('/')!==end.join('/'))throw Error('所选块包含未闭合结构，不能移动。');
  return start;
}
function groupEnd(source:string,at:number,open:string,close:string) {
  if(source[at]!==open)return -1;let depth=0;
  for(let i=at;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]===open)depth++;if(source[i]===close&&--depth===0)return i+1;}
  return -1;
}
function commandEnd(source:string,at:number,args:number) {
  const command=/^\\[A-Za-z@]+\*?/.exec(source.slice(at));if(!command)return -1;at+=command[0].length;
  for(let i=0;i<args;i++){
    while(/\s/.test(source[at]||'')&&at<source.length)at++;
    while(source[at]==='['){const end=groupEnd(source,at,'[',']');if(end<0)return -1;at=end;while(/\s/.test(source[at]||'')&&at<source.length)at++;}
    const end=groupEnd(source,at,'{','}');if(end<0)return -1;at=end;
  }
  return at;
}
/** Comments are already masked. Formatting declarations/spacing between a caption
 * and its tabular do not make them independent; prose or another structure does. */
function onlyDecorations(source:string) {
  let at=0;
  while(at<source.length){
    if(/\s|[{}]/.test(source[at])){at++;continue;}
    const command=/^\\([A-Za-z@]+)\*?/.exec(source.slice(at));if(!command||/^(?:begin|end|part|chapter|section|subsection|subsubsection|paragraph|subparagraph|input|include|maketitle)$/.test(command[1]))return false;
    at+=command[0].length;
    while(true){while(/\s/.test(source[at]||'')&&at<source.length)at++;const open=source[at];if(open!=='{'&&open!=='[')break;const end=groupEnd(source,at,open,open==='{'?'}':']');if(end<0)return false;at=end;}
  }
  return true;
}
function independentTable(parsed:Scan,table:Environment) {
  if(parsed.environments.some(env=>env.name!=='document'&&env.from<table.from&&env.to>table.to))return false;
  for(const command of parsed.commands){
    if(!/^(?:captionof|caption|label)$/.test(command.name)||command.at>=table.from&&command.at<table.to)continue;
    // Captions belonging to a different complete object must not block this one.
    if(parsed.environments.some(env=>env.name!=='document'&&env.from<command.at&&env.to>command.at))continue;
    if(command.at>=table.to&&onlyDecorations(parsed.masked.slice(table.to,command.at)))return false;
    const end=commandEnd(parsed.masked,command.at,command.name==='captionof'?2:1);
    if(end>=0&&end<=table.from&&onlyDecorations(parsed.masked.slice(end,table.from)))return false;
  }
  return true;
}
function objectTarget(file: SourceFile,target: BlockTarget,parsed: Scan): BlockTarget {
  exact(file,target);body(parsed,target);
  if(target.kind!=='source')throw Error('拖动来源不是完整的图片或表格。');
  const containing=parsed.environments.filter(env=>env.from<=target.from&&env.to>=target.to);
  const outer=containing.filter(env=>floats.test(env.name)).sort((a,b)=>a.from-b.from)[0]
    ||containing.filter(env=>tables.test(env.name)).sort((a,b)=>a.from-b.from)[0];
  if(!outer)throw Error('此图片位于标题宏、内联命令或其他特殊结构中，请在源码中调整位置。');
  if(tables.test(outer.name)&&!independentTable(parsed,outer))throw Error('此裸表格与外部标题、标签或布局环境绑定，不能单独移动；请在源码中调整完整结构。');
  const result: BlockTarget={file:file.name,from:outer.from,to:outer.to,text:file.content.slice(outer.from,outer.to),kind:'source',mode:'latex',label:/^figure/.test(outer.name)?'图片整体':'表格整体'};
  body(parsed,result);
  const context=completeScope(parsed,result);
  if(context.some(entry=>entry.startsWith('group@')))throw Error('此图表位于宏参数或局部分组内，请在源码中调整位置。');
  // Do not detach a table/figure from a surrounding float of another kind.
  if(containing.some(env=>floats.test(env.name)&&env.from<outer.from))throw Error('嵌套图表结构请在源码中调整位置。');
  return result;
}

/** Promote an includegraphics hit to the complete float with its caption/label. */
export function objectMoveTarget(file: SourceFile,target: BlockTarget): BlockTarget {
  const parsed=scan(file.content);
  return target.kind==='paragraph'?destinationTarget(file,target,parsed):objectTarget(file,target,parsed);
}
function destinationTarget(file: SourceFile,target: BlockTarget,parsed: Scan) {
  exact(file,target);body(parsed,target);
  if(target.kind==='source')return objectTarget(file,target,parsed);
  const canonical=paragraphTarget(file.content,target.from);
  if(target.kind!=='paragraph'||!canonical||canonical.kind!=='paragraph'||canonical.from!==target.from||canonical.to!==target.to)throw Error('落点必须是完整正文段落或图表边界。');
  completeScope(parsed,target);return target;
}

export interface ObjectMoveOptions { placement?: 'preserve'|'near' }
function nearPlacement(text:string) {
  const begin=/^\\begin\s*\{\s*(figure|table)(\*)?\s*\}/.exec(text);if(!begin)return text;
  const placement=begin[2]?'[!tp]':'[!htbp]';let at=begin[0].length;
  while(at<text.length){if(/\s/.test(text[at])){at++;continue;}if(text[at]==='%'){const end=text.indexOf('\n',at);at=end<0?text.length:end;continue;}break;}
  if(text[at]==='['){const end=text.indexOf(']',at+1);if(end<0)throw Error('浮动位置参数不完整，请在源码中调整。');return text.slice(0,at)+placement+text.slice(end+1);}
  return text.slice(0,begin[0].length)+placement+text.slice(begin[0].length);
}

/** Changes source order, never absolute PDF coordinates. Existing float placement
 * is retained unless the caller explicitly requests TeX's nearby-placement hints. */
export function moveObject(files: SourceFile[],source: BlockTarget,destination: BlockTarget,after: boolean,options: ObjectMoveOptions={}): FileChange[] {
  const a=files.find(file=>file.name===source.file),b=files.find(file=>file.name===destination.file);if(!a||!b)throw Error('找不到图表或落点所在文件。');
  const aScan=scan(a.content),bScan=a===b?aScan:scan(b.content),origin=destinationTarget(a,source,aScan),target=destinationTarget(b,destination,bScan);
  const startScope=completeScope(aScan,origin),endScope=completeScope(bScan,target);
  if(startScope.join('/')!==endScope.join('/')||(a.name!==b.name&&(startScope.length||endScope.length)))throw Error('不能跨越摘要、列表、条件分支或局部分组边界移动图表。');
  if(a.name===b.name&&origin.from===target.from&&origin.to===target.to)return [];
  if(a.name===b.name&&origin.from<target.to&&target.from<origin.to)throw Error('源图表与落点重叠，请选择外部边界。');
  let from=origin.from,to=origin.to;
  const following=/^[\t \r]*\n[\t \r]*\n/.exec(a.content.slice(to));
  if(following)to+=following[0].length;
  else {const preceding=/\n[\t \r]*\n[\t \r]*$/.exec(a.content.slice(0,from));if(preceding)from-=preceding[0].length;}
  const at=after?target.to:target.from,block=options.placement==='near'?nearPlacement(origin.text):origin.text,insertion=after?'\n\n'+block:block+'\n\n';
  const removed=a.content.slice(0,from)+a.content.slice(to);
  if(a.name===b.name){
    if(at>from&&at<to)throw Error('源图表与落点重叠，请选择外部边界。');
    const point=at>=to?at-(to-from):at,next=removed.slice(0,point)+insertion+removed.slice(point);
    return next===a.content?[]:[{file:a.name,before:a.content,after:next}];
  }
  return [{file:a.name,before:a.content,after:removed},{file:b.name,before:b.content,after:b.content.slice(0,at)+insertion+b.content.slice(at)}];
}

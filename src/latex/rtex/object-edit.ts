import type { BlockTarget } from './block-edit';
import type { PageCharacter } from './page-geometry';
import type { PageRow } from './math-hit';
import { SP_PER_BP } from './vendor/protocol';
import { paragraphTarget } from './block-edit';

export interface Graphic { from: number; to: number; text: string; path: string; options: string }
export interface ObjectRegion { kind: 'image'|'table'; page: number; x: number; y: number; w: number; h: number; target: Omit<BlockTarget,'file'> }
function endGroup(source: string, at: number, open: string, close: string) {
  if(source[at]!==open)return at;let depth=0;
  for(let i=at;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)return -1;i=end;continue;}if(source[i]===open)depth++;if(source[i]===close&&--depth===0)return i+1;}
  return -1;
}
export function graphics(source: string): Graphic[] {
  const result: Graphic[]=[];
  for(let i=0;i<source.length;i++){
    if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)break;i=end;continue;}
    if(source[i]!=='\\')continue;
    const match=/^\\includegraphics\*?\s*/.exec(source.slice(i));if(!match){i++;continue;}
    let at=i+match[0].length,options='';
    if(source[at]==='['){const end=endGroup(source,at,'[',']');if(end<0)continue;options=source.slice(at+1,end-1);at=end;}
    while(/\s/.test(source[at]||'')&&at<source.length)at++;
    const end=endGroup(source,at,'{','}');if(end<=at)continue;
    result.push({from:i,to:end,text:source.slice(i,end),path:source.slice(at+1,end-1),options});i=end-1;
  }
  return result;
}
function splitOptions(text: string) {
  const parts: string[]=[];let depth=0,start=0;
  for(let i=0;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='{')depth++;if(text[i]==='}')depth--;if(text[i]===','&&depth===0){parts.push(text.slice(start,i));start=i+1;}}
  if(text.slice(start).trim())parts.push(text.slice(start));return parts;
}
const dimension=/^\s*([\d.]+)?\s*(\\(?:line|column|text)width|bp|pt|cm|mm|in|em|ex)\s*$/;
/** Scale existing dimensions in their original units; keep trim, clip, rotation and paths. */
export function resizeGraphic(command: string, ratio: number, renderedWidthBp: number) {
  if(!Number.isFinite(ratio)||ratio<.05||ratio>10)throw Error('图片缩放超出范围。');
  const graphic=graphics(command);if(graphic.length!==1||graphic[0].from!==0||graphic[0].to!==command.length)throw Error('无法唯一识别图片命令。');
  const options=splitOptions(graphic[0].options);let changed=false;
  const next=options.map(part=>{
    const equal=part.indexOf('=');if(equal<0)return part;
    const key=part.slice(0,equal).trim(),value=part.slice(equal+1);
    if(key==='width'||key==='height'||key==='totalheight'){
      const match=dimension.exec(value);if(!match||(!match[1]&&!match[2].startsWith('\\')))throw Error('此尺寸由自定义宏计算，请在源码中调整。');
      changed=true;return part.slice(0,equal+1)+(Number(match[1]||1)*ratio).toFixed(4).replace(/\.?0+$/,'')+match[2];
    }
    if(key==='scale'){const valueNumber=Number(value);if(!Number.isFinite(valueNumber))throw Error('图片 scale 参数不是数值。');changed=true;return part.slice(0,equal+1)+(valueNumber*ratio).toFixed(4).replace(/\.?0+$/,'');}
    return part;
  });
  // A width and a scale together would multiply the ratio twice. Keep scale unchanged.
  const hasDimension=options.some(p=>/^\s*(?:width|height|totalheight)\s*=/.test(p));
  if(hasDimension)for(let i=0;i<options.length;i++)if(/^\s*scale\s*=/.test(options[i]))next[i]=options[i];
  if(!changed)next.push(`width=${(renderedWidthBp*ratio).toFixed(3)}bp`);
  return command.replace(/^(\\includegraphics\*?)\s*(?:\[[\s\S]*?\])?\s*(?=\{)/,(_,name:string)=>name+'['+next.join(',')+']');
}

export interface ResizeAxes { x: number; y: number }
export interface RenderedSize { widthBp: number; heightBp: number }
const numberText=(value:number)=>Number(value.toFixed(6)).toString();
function checkResize(ratios:ResizeAxes,size:RenderedSize){
  if(![ratios.x,ratios.y].every(value=>Number.isFinite(value)&&value>=.05&&value<=10))throw Error('缩放超出范围。');
  if(![size.widthBp,size.heightBp].every(value=>Number.isFinite(value)&&value>0))throw Error('无法识别对象的实际宽高。');
}
function scaledDimension(value:string,ratio:number){
  const match=dimension.exec(value);if(!match||(!match[1]&&!match[2].startsWith('\\')))throw Error('此尺寸由自定义宏计算，请在源码中调整。');
  return numberText(Number(match[1]||1)*ratio)+match[2];
}
/** Corners use equal x/y; side handles may stretch one axis explicitly. A generated
 * reference dimension stays in its original unit whenever it represents actual size. */
export function resizeGraphicAxes(command:string,ratios:ResizeAxes,size:RenderedSize){
  checkResize(ratios,size);
  if(Math.abs(ratios.x-ratios.y)<1e-8)return resizeGraphic(command,ratios.x,size.widthBp);
  const list=graphics(command);if(list.length!==1||list[0].from!==0||list[0].to!==command.length)throw Error('无法唯一识别图片命令。');
  const graphic=list[0],options=splitOptions(graphic.options),entries=options.map(part=>{
    const equal=part.indexOf('=');return {part,key:(equal<0?part:part.slice(0,equal)).trim(),value:equal<0?'':part.slice(equal+1),equal};
  });
  const last=(key:string)=>[...entries].reverse().find(entry=>entry.key===key),angle=last('angle');
  if(angle&&(!Number.isFinite(Number(angle.value))||Math.abs(Number(angle.value)%360)>1e-8))throw Error('旋转图片请使用角柄等比缩放；非等比拉伸请在源码中调整。');
  for(const entry of entries){
    if(['width','height','totalheight'].includes(entry.key))scaledDimension(entry.value,1);
    if(entry.key==='scale'&&(!Number.isFinite(Number(entry.value))||Number(entry.value)<=0))throw Error('图片 scale 参数不是正数。');
  }
  const width=last('width'),height=[...entries].reverse().find(entry=>entry.key==='height'||entry.key==='totalheight'),keep=last('keepaspectratio');
  const hasConstraint=!!keep&&(keep.value.trim()===''||keep.value.trim().toLowerCase()==='true')&&!!width&&!!height;
  const widthValue=width&&!hasConstraint?scaledDimension(width.value,ratios.x):numberText(size.widthBp*ratios.x)+'bp';
  const heightValue=height&&!hasConstraint?scaledDimension(height.value,ratios.y):numberText(size.heightBp*ratios.y)+'bp';
  // Put final dimensions after scale/angle, so key ordering cannot apply a scale twice.
  const retained=entries.filter(entry=>!['width','height','totalheight','keepaspectratio'].includes(entry.key)).map(entry=>entry.part);
  retained.push('width='+widthValue,(height?.key==='totalheight'?'totalheight':'height')+'='+heightValue,'keepaspectratio=false');
  const name=/^\\includegraphics\*?/.exec(command)![0];return name+'['+retained.join(',')+']'+command.slice(command.lastIndexOf('{'+graphic.path+'}'));
}

interface EnvironmentRange {name:string;from:number;to:number}
function environmentAt(source:string,from:number):EnvironmentRange|null{
  const first=/^\\begin\{([^}]+)\}/.exec(source.slice(from));if(!first)return null;
  const stack:string[]=[];
  for(let i=from;i<source.length;i++){
    if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)return null;i=end;continue;}
    if(source[i]!=='\\')continue;
    const match=/^\\(begin|end)\{([^}]+)\}/.exec(source.slice(i));if(!match){i++;continue;}
    if(match[1]==='begin')stack.push(match[2]);else if(stack.pop()!==match[2])return null;
    if(!stack.length)return {name:first[1],from,to:i+match[0].length};i+=match[0].length-1;
  }
  return null;
}
function tableRange(source:string):EnvironmentRange{
  const stack:{name:string;from:number}[]=[],tables:EnvironmentRange[]=[];
  for(let i=0;i<source.length;i++){
    if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)break;i=end;continue;}
    if(source[i]!=='\\')continue;
    const match=/^\\(begin|end)\{([^}]+)\}/.exec(source.slice(i));if(!match){i++;continue;}
    const name=match[2];
    if(/^(?:longtable|longtblr|tblr|ltablex)$/.test(name))throw Error('多页或自定义表格需要在源码中调整尺寸。');
    if(match[1]==='begin')stack.push({name,from:i});
    else {
      const open=stack.pop();if(!open||open.name!==name)throw Error('表格环境边界不完整。');
      if(/^tabular(?:\*|x)?$/.test(name)&&!stack.some(entry=>/^tabular(?:\*|x)?$/.test(entry.name)))tables.push({...open,to:i+match[0].length});
    }
    i+=match[0].length-1;
  }
  if(stack.length||tables.length!==1)throw Error('仅可整体缩放一个完整 tabular 表格，复杂结构请在源码中调整。');
  return tables[0];
}
interface Wrapper { kind:'resizebox'|'scalebox';from:number;to:number;xFrom:number;xTo:number;yFrom:number;yTo:number;contentFrom:number;contentTo:number;optionalY:boolean }
function skipSpace(source:string,at:number){
  while(at<source.length){if(/\s/.test(source[at])){at++;continue;}if(source[at]==='%'){const end=source.indexOf('\n',at);if(end<0)return source.length;at=end+1;continue;}break;}return at;
}
function tableWrappers(source:string,table:EnvironmentRange):Wrapper[]{
  const wrappers:Wrapper[]=[];
  for(let i=0;i<table.from;i++){
    if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)break;i=end;continue;}
    if(source[i]!=='\\')continue;
    const match=/^\\(resizebox\*?|scalebox)\s*/.exec(source.slice(i));if(!match){i++;continue;}
    let at=skipSpace(source,i+match[0].length);const xEnd=endGroup(source,at,'{','}');if(xEnd<=at)continue;
    const xFrom=at+1,xTo=xEnd-1;at=skipSpace(source,xEnd);
    let yFrom=-1,yTo=-1,optionalY=false;
    if(match[1]==='scalebox'){
      if(source[at]==='['){const end=endGroup(source,at,'[',']');if(end<=at)continue;yFrom=at+1;yTo=end-1;optionalY=true;at=skipSpace(source,end);}
    }else{const end=endGroup(source,at,'{','}');if(end<=at)continue;yFrom=at+1;yTo=end-1;at=skipSpace(source,end);}
    const contentEnd=endGroup(source,at,'{','}');if(contentEnd<=at)continue;
    if(at<table.from&&contentEnd>table.to)wrappers.push({kind:match[1]==='scalebox'?'scalebox':'resizebox',from:i,to:contentEnd,xFrom,xTo,yFrom,yTo,contentFrom:at+1,contentTo:contentEnd-1,optionalY});
  }
  return wrappers.sort((a,b)=>a.from-b.from);
}
function replaceRanges(source:string,changes:{from:number;to:number;text:string}[]){let next=source;for(const change of changes.sort((a,b)=>b.from-a.from))next=next.slice(0,change.from)+change.text+next.slice(change.to);return next;}
export interface TableResizeResult {text:string;requiresGraphicx:boolean}
/** Keep caption/label outside the scaled body. Existing outer scale wrappers are
 * edited rather than nested again; resizebox dimension units remain template-relative. */
export function resizeTable(source:string,ratios:ResizeAxes,size:RenderedSize):TableResizeResult{
  checkResize(ratios,size);const table=tableRange(source),wrappers=tableWrappers(source,table),wrapper=wrappers[0];
  const before=source.slice(0,table.from);
  if(/\\(?:rotatebox|adjustbox|maxsizebox|parbox|makebox)\b/.test(before)&&!wrapper)throw Error('此表格由其他版式命令包裹，请在源码中调整尺寸。');
  const bodyOutside=wrapper?source.slice(wrapper.contentFrom,table.from)+source.slice(table.to,wrapper.contentTo):'';
  if(/\\(?:caption(?:of)?|label)\b/.test(bodyOutside))throw Error('现有缩放范围包含标题或标签，请先在源码中分离表格内容。');
  const wrap=(from:number,to:number)=>source.slice(0,from)+`\\scalebox{${numberText(ratios.x)}}${Math.abs(ratios.x-ratios.y)<1e-8?'':`[${numberText(ratios.y)}]`}{`+source.slice(from,to)+'}'+source.slice(to);
  if(!wrapper)return {text:wrap(table.from,table.to),requiresGraphicx:true};
  const x=source.slice(wrapper.xFrom,wrapper.xTo).trim(),y=wrapper.yFrom<0?x:source.slice(wrapper.yFrom,wrapper.yTo).trim();
  if(wrapper.kind==='scalebox'){
    if(![x,y].every(value=>/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)&&Number(value)>0))throw Error('表格缩放比例由自定义宏计算，请在源码中调整。');
    const sx=numberText(Number(x)*ratios.x),sy=numberText(Number(y)*ratios.y);
    const prefix=`\\scalebox{${sx}}${wrapper.optionalY||sx!==sy?`[${sy}]`:''}{`;
    return {text:source.slice(0,wrapper.from)+prefix+source.slice(wrapper.contentFrom),requiresGraphicx:true};
  }
  if(x!=='!')scaledDimension(x,1);if(y!=='!')scaledDimension(y,1);
  if(x==='!'&&y==='!')throw Error('表格 resizebox 缺少有效尺寸。');
  if(Math.abs(ratios.x-ratios.y)>1e-8&&(x==='!'||y==='!'))return {text:wrap(wrapper.from,wrapper.to),requiresGraphicx:true};
  return {text:replaceRanges(source,[{from:wrapper.xFrom,to:wrapper.xTo,text:x==='!'?'!':scaledDimension(x,ratios.x)},{from:wrapper.yFrom,to:wrapper.yTo,text:y==='!'?'!':scaledDimension(y,ratios.y)}]),requiresGraphicx:true};
}

export function tableSetting(source: string, name: 'columns'|'rows', value: number) {
  if(!Number.isFinite(value)||(name==='columns'?(value<.5||value>24):(value<.6||value>3)))throw Error('表格间距超出范围。');
  const literal=String(Number(value.toFixed(2)));
  const pattern=name==='columns'?/\\setlength\s*\{\\tabcolsep\}\s*\{[^{}]*\}/:/\\renewcommand\s*\{\\arraystretch\}\s*\{[^{}]*\}/;
  const setting=name==='columns'?`\\setlength{\\tabcolsep}{${literal}pt}`:`\\renewcommand{\\arraystretch}{${literal}}`;
  if(pattern.test(source))return source.replace(pattern,()=>setting);
  const outer=/^\\begin\{table\*?\}(?:\[[^\]]*\])?/.exec(source);
  if(outer)return source.slice(0,outer[0].length)+'\n'+setting+source.slice(outer[0].length);
  if(/^\\(?:scalebox|resizebox\*?)\b/.test(source)){
    const table=tableRange(source),wrapper=tableWrappers(source,table)[0];
    if(wrapper&&wrapper.from===0)return source.slice(0,table.from)+setting+'\n'+source.slice(table.from);
  }
  if(/^\{[\s\S]*\}$/.test(source))return '{'+setting+'\n'+source.slice(1);
  if(/^\\begin\{tabular(?:\*|x)?\}/.test(source))return '{'+setting+'\n'+source+'}';
  throw Error('此表格结构需要在源码中调整。');
}
export function tableValues(source: string) {
  return {columns:Number(/\\setlength\s*\{\\tabcolsep\}\s*\{([\d.]+)pt\}/.exec(source)?.[1]||6),rows:Number(/\\renewcommand\s*\{\\arraystretch\}\s*\{([\d.]+)\}/.exec(source)?.[1]||1)};
}

type Matrix=[number,number,number,number,number,number];
const identity=():Matrix=>[1,0,0,1,0,0];
function mul(a: Matrix,b: Matrix):Matrix{return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
function transformedRect(matrix:Matrix,x:number,y:number,w:number,h:number){
  const points=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([px,py])=>[matrix[0]*px+matrix[2]*py+matrix[4],matrix[1]*px+matrix[3]*py+matrix[5]]);
  const left=Math.min(...points.map(p=>p[0])),top=Math.min(...points.map(p=>p[1]));
  return {x:left,y:top,w:Math.max(...points.map(p=>p[0]))-left,h:Math.max(...points.map(p=>p[1]))-top};
}
function tableDrawing(rows:PageRow[],characters:PageCharacter[]){
  const mapped=new Map<PageCharacter,PageCharacter>(),rules:(ReturnType<typeof transformedRect>&{page:number;line:number})[]=[];
  rows.forEach((row,line)=>{
    const chars=characters.filter(g=>g.line===line);let matrix=identity();const stack:Matrix[]=[];
    for(const item of row.line.items){
      if(item[0]==='M'){
        if(item[1]==='save')stack.push(matrix);else if(item[1]==='restore')matrix=stack.pop()||identity();
        else {const values=String(item[4]||'').trim().split(/\s+/).map(Number);if(values.length===4&&values.every(Number.isFinite)){const[a,b,c,d]=[values[0],-values[1],-values[2],values[3]],x=Number(item[2])+row.dx,y=Number(item[3])+row.dy;matrix=mul(matrix,[a,b,c,d,x-a*x-c*y,y-b*x-d*y]);}}
      }
      if(item[0]==='g'){
        const x=Number(item[4])+row.dx,y=Number(item[5])+row.dy,size=row.dl.fonts[String(item[1])]?.size||655360,advance=Number(item[6]);
        for(const ch of chars){
          if(Math.min(ch.x,ch.x+ch.w)<Math.min(x,x+advance)-2||Math.max(ch.x,ch.x+ch.w)>Math.max(x,x+advance)+2||Math.abs(ch.y-(y-size*.8))>2)continue;
          mapped.set(ch,{...ch,...transformedRect(matrix,ch.x,ch.y,ch.w,ch.h)});
        }
      }
      if(item[0]==='r')rules.push({page:row.page,line,...transformedRect(matrix,Number(item[1])+row.dx,Number(item[2])+row.dy,Number(item[3]),Number(item[4]))});
    }
  });
  return {characters:characters.map(g=>mapped.get(g)||g),rules};
}
/** Old rtex versions encode imported PDF figures as transformed rectangle placeholders. */
export function imageRectangles(rows: PageRow[]) {
  const result: {page:number;x:number;y:number;w:number;h:number}[]=[];
  for(const row of rows){
    if(row.line.items.some(item=>item[0]==='g'))continue;
    let matrix=identity();const stack: Matrix[]=[];
    for(const item of row.line.items){
      if(item[0]==='M'){
        if(item[1]==='save')stack.push(matrix);else if(item[1]==='restore')matrix=stack.pop()||identity();
        else {const values=String(item[4]||'').trim().split(/\s+/).map(Number);if(values.length===4&&values.every(Number.isFinite)){const [a,b,c,d]=[values[0],-values[1],-values[2],values[3]],x=Number(item[2])+row.dx,y=Number(item[3])+row.dy;matrix=mul(matrix,[a,b,c,d,x-a*x-c*y,y-b*x-d*y]);}}
      }
      if(item[0]!=='r'&&item[0]!=='i')continue;
      const start=item[0]==='i'?2:1,x=Number(item[start])+row.dx,y=Number(item[start+1])+row.dy,w=Number(item[start+2]),h=Number(item[start+3]);
      const points=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([px,py])=>[matrix[0]*px+matrix[2]*py+matrix[4],matrix[1]*px+matrix[3]*py+matrix[5]]);
      const left=Math.min(...points.map(p=>p[0])),top=Math.min(...points.map(p=>p[1])),width=Math.max(...points.map(p=>p[0]))-left,height=Math.max(...points.map(p=>p[1]))-top;
      if(width>12*SP_PER_BP&&height>12*SP_PER_BP)result.push({page:row.page,x:left,y:top,w:width,h:height});
    }
  }
  return result;
}
export function objectRegions(rows: PageRow[], source: string, characters: PageCharacter[]): ObjectRegion[] {
  const regions: ObjectRegion[]=[],commands=graphics(source),boxes=imageRectangles(rows);
  // Ambiguous figures are left to the explicit source entry, never paired by guessing.
  if(commands.length===boxes.length)commands.forEach((command,i)=>regions.push({...boxes[i],kind:'image',target:{from:command.from,to:command.to,text:command.text,kind:'source',mode:'latex',label:'图片'}}));
  const tables=new Map<string,Omit<BlockTarget,'file'>>();
  for(const match of source.matchAll(/\\begin\{tabular(?:\*|x)?\}/g)){
    let target=paragraphTarget(source,match.index!);if(target?.kind!=='source')continue;
    if(/^\\begin\{tabular(?:\*|x)?\}/.test(target.text)){
      const range=environmentAt(source,target.from);if(!range)continue;
      target={...target,to:range.to,text:source.slice(range.from,range.to)};
      const wrapper=tableWrappers(source,range)[0];
      if(wrapper){
        const outside=source.slice(wrapper.contentFrom,range.from)+source.slice(range.to,wrapper.contentTo);
        if(/\\(?:caption(?:of)?|label)\b/.test(outside))continue;
        target={...target,from:wrapper.from,to:wrapper.to,text:source.slice(wrapper.from,wrapper.to)};
      }
    }
    tables.set(target.from+':'+target.to,target);
  }
  for(const target of tables.values()){
    let body:EnvironmentRange;try{body=tableRange(target.text);}catch{continue;}
    const from=target.from+body.from,to=target.from+body.to,raw=characters.filter(g=>g.from>=from&&g.to<=to),drawing=tableDrawing(rows,raw);
    for(const page of new Set(rows.map(r=>r.page))){
      const glyphs=drawing.characters.filter(g=>g.page===page);if(!glyphs.length)continue;
      let x=Math.min(...glyphs.map(g=>g.x)),y=Math.min(...glyphs.map(g=>g.y)),right=Math.max(...glyphs.map(g=>g.x+g.w)),bottom=Math.max(...glyphs.map(g=>g.y+g.h));
      const lineIds=new Set(glyphs.map(g=>g.line)),height=Math.max(...glyphs.map(g=>g.h));
      for(const rule of drawing.rules){if(rule.page!==page||!lineIds.has(rule.line)||rule.h>height*.8||rule.w<height||rule.y<y-height||rule.y>bottom+height||rule.x>right||rule.x+rule.w<x)continue;x=Math.min(x,rule.x);y=Math.min(y,rule.y);right=Math.max(right,rule.x+rule.w);bottom=Math.max(bottom,rule.y+rule.h);}
      regions.push({kind:'table',page,x,y,w:right-x,h:bottom-y,target});
    }
  }
  return regions;
}

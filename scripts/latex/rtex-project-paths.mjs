import path from 'node:path';
import {createHash} from 'node:crypto';
const slash=value=>String(value).replaceAll('\\','/');
function relativeFile(value){const file=slash(value);if(!file||file.includes('\0')||path.posix.isAbsolute(file)||/^[a-z]:/i.test(file))return null;const normal=path.posix.normalize(file);return normal==='.'||normal==='..'||normal.startsWith('../')?null:normal.replace(/^\.\//,'');}
/** Only the native session is scoped to the selected main's directory. Editor,
 * save/agent capabilities and wire source keys remain relative to the project. */
export function realtimeProjectPaths(root,main,{pathApi=path}={}){
 const selected=relativeFile(main);if(!selected)throw Error('Invalid realtime main path.');
 const directory=path.posix.dirname(selected),prefix=directory==='.'?'':directory+'/';
 const nativeRoot=pathApi.resolve(root,...(directory==='.'?[]:directory.split('/')));
 return {nativeRoot,nativeMain:path.posix.basename(selected),prefix,cacheName:selected==='main.tex'?'':'main-'+createHash('sha256').update(selected).digest('hex').slice(0,20),
  toNative(file){const name=relativeFile(file);return name!==null&&name.startsWith(prefix)?name.slice(prefix.length)||null:null;},
  toProject(file){if(typeof file!=='string')return null;let name=file;if(pathApi.isAbsolute(file)){name=pathApi.relative(nativeRoot,file);if(pathApi.isAbsolute(name))return null;}name=relativeFile(name);return name===null?null:prefix+name;}
 };
}
const uncomment=source=>source.split('\n').map(line=>{let out='';for(let i=0;i<line.length;i++){if(line[i]==='%'){let n=0;for(let j=i-1;j>=0&&line[j]==='\\';j--)n++;if(n%2===0)break;}out+=line[i];}return out;}).join('\n');
/** Native 0.0.6 cannot maintain source bindings outside its project root. Refuse
 * an explicit escaping dependency instead of silently omitting it from snapshots. */
export function externalRealtimeDependency(main,documents){
 const directory=path.posix.dirname(slash(main));if(directory==='.')return null;
 const prefix=directory+'/',files=new Map(documents.map(f=>[slash(f.name),f.content])),seen=new Set(),queue=[slash(main)];
 const resolve=raw=>{const target=raw.trim().replace(/^['"]|['"]$/g,'');if(!target||target.includes('\\')||target.includes('#'))return null;if(path.posix.isAbsolute(target)||/^[a-z]:/i.test(target))return {escape:true,target};const name=path.posix.normalize(path.posix.join(directory,target));return {escape:!name.startsWith(prefix),target,name};};
 while(queue.length){const file=queue.shift();if(seen.has(file))continue;seen.add(file);const text=uncomment(files.get(file)||'');
  const specs=[];for(const match of text.matchAll(/\\(?:input|include|subfile|includegraphics|bibliography|addbibresource|documentclass|LoadClass(?:WithOptions)?|usepackage|RequirePackage(?:WithOptions)?)\*?(?:\s*\[[^\]]*\])?\s*(?:\{([^}]+)\}|([^\s{}%]+))/g))for(const value of (match[1]||match[2]).split(','))specs.push(value);
  for(const match of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g))for(const part of match[1].matchAll(/\{([^}]*)\}/g))specs.push(part[1]);
  for(const spec of specs){const ref=resolve(spec);if(!ref)continue;if(ref.escape)return ref.target;for(const candidate of [ref.name,ref.name+'.tex',ref.name+'.sty',ref.name+'.cls'])if(files.has(candidate))queue.push(candidate);}
 }return null;
}
/** Diagnostics carry source paths; display lists/font/image paths and numeric
 * source IDs are intentionally not rewritten. */
export function realtimeDiagnosticPaths(value,paths,sourceFiles){
 const known=new Set(sourceFiles),map=item=>{if(!item||typeof item.file!=='string')return item;const file=paths.toProject(item.file);return file&&known.has(file)?{...item,file}:item;};
 if(value.event==='Diagnostics'&&Array.isArray(value.items))return {...value,items:value.items.map(map)};
 if(Array.isArray(value.diagnostics))return {...value,diagnostics:value.diagnostics.map(map)};
 return value;
}

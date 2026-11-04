import type {SourceFile} from '../source-map';
function normalized(path:string){const result:string[]=[];for(const part of path.replaceAll('\\','/').split('/')){if(!part||part==='.')continue;if(part==='..')result.pop();else result.push(part);}return result.join('/').toLowerCase();}
function uncomment(source:string){let out='';for(let i=0;i<source.length;i++){if(source[i]==='\\'){out+=source.slice(i,i+2);i++;continue;}if(source[i]==='%'){const end=source.indexOf('\n',i);if(end<0)break;i=end;}out+=source[i];}return out;}
/** Conservative source evidence from the active compilation graph. An unrelated
 * supplementary file must not authorize inserting graphics macros into the main. */
export function sourceSupportsGraphics(files:SourceFile[],main:string){
  const sources=new Map(files.map(file=>[normalized(file.name),file.content])),root=normalized(main),rootDir=root.slice(0,Math.max(0,root.lastIndexOf('/'))),queue=[root],seen=new Set<string>();
  const resolve=(name:string,current:string,extension:string)=>{
    const directory=current.slice(0,Math.max(0,current.lastIndexOf('/'))),withExtension=/\.[A-Za-z]+$/.test(name)?name:name+extension;
    return [rootDir+'/'+withExtension,directory+'/'+withExtension,withExtension].map(normalized).find(path=>sources.has(path));
  };
  while(queue.length){const name=queue.shift()!;if(seen.has(name))continue;seen.add(name);const source=uncomment(sources.get(name)||'');
    for(const match of source.matchAll(/\\(?:usepackage|RequirePackage|documentclass|LoadClass)(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g))for(const item of match[1].split(',').map(s=>s.trim())){
      if(item==='graphicx'||item==='graphics')return true;
      const dependency=resolve(item,name,/documentclass|LoadClass/.test(match[0])?'.cls':'.sty');if(dependency)queue.push(dependency);
    }
    for(const match of source.matchAll(/\\(?:input|include)\s*\{([^{}]+)\}/g)){const dependency=resolve(match[1].trim(),name,'.tex');if(dependency)queue.push(dependency);}
  }
  return false;
}

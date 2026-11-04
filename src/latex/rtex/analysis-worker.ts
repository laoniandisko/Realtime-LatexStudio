import {analyzeUnit} from './analyze-unit';
const scope=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage(value:unknown):void};
scope.onmessage=event=>{
  const {id,rows,source}=event.data;
  try {scope.postMessage({id,result:analyzeUnit(rows,source)});}
  catch(error){scope.postMessage({id,error:String(error)});}
};

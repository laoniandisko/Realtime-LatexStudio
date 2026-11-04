import {analyzeUnit,type UnitAnalysis} from './analyze-unit';
import type {PageRow} from './math-hit';
export const sameRows=(a:PageRow[],b:PageRow[])=>a.length===b.length&&a.every((row,i)=>row.line===b[i].line&&row.dl===b[i].dl&&row.page===b[i].page&&row.dx===b[i].dx&&row.dy===b[i].dy);
type Entry={source:string;rows:PageRow[];result:Promise<UnitAnalysis>};
type Task=Entry&{unit:number;id:number;resolve:(value:UnitAnalysis)=>void;reject:(error:Error)=>void};
export class AnalysisCancelledError extends Error {
  constructor(){super('Analysis cancelled');this.name='AnalysisCancelledError';}
}
export const isAnalysisCancelled=(error:unknown):error is AnalysisCancelledError=>error instanceof AnalysisCancelledError;
/** Expensive glyph/source alignment never runs in the browser's input thread. */
export class UnitAnalyzer {
  private worker:Worker|null=null;
  private sequence=0;
  private active:Task|null=null;
  private queued=new Map<number,Task>();
  private fallbackTimer:ReturnType<typeof setTimeout>|undefined;
  private cache=new Map<number,Entry>();
  reset(){this.fail(new AnalysisCancelledError());}
  analyze(id:number,rows:PageRow[],source:string):Promise<UnitAnalysis>{
    const old=this.cache.get(id);
    if(old?.source===source&&sameRows(old.rows,rows))return old.result;
    // An undo may return to the snapshot already being analyzed. Reuse its exact
    // geometry rather than cloning and analyzing the same display list twice.
    if(this.active?.unit===id&&this.active.source===source&&sameRows(this.active.rows,rows)){
      this.queued.get(id)?.reject(new AnalysisCancelledError());this.queued.delete(id);
      this.cache.set(id,this.active);return this.active.result;
    }
    let resolve:Task['resolve'],reject:Task['reject'];
    const result=new Promise<UnitAnalysis>((yes,no)=>{resolve=yes;reject=no;});
    const task:Task={unit:id,id:++this.sequence,source,rows,result,resolve:resolve!,reject:reject!};
    // Only the newest waiting snapshot per unit is useful. In-flight results
    // still resolve for their original callers; a newer result must never be
    // returned for an old source because its offsets would be unsafe.
    this.queued.get(id)?.reject(new AnalysisCancelledError());this.queued.set(id,task);
    this.cache.set(id,task);
    void result.catch(()=>{if(this.cache.get(id)?.result===result)this.cache.delete(id);});
    if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value!);
    this.pump();
    return result;
  }
  private pump(){
    if(this.active||!this.queued.size)return;
    const task=this.queued.values().next().value!;this.queued.delete(task.unit);this.active=task;
    if(typeof Worker==='undefined'){
      this.fallbackTimer=setTimeout(()=>{
        this.fallbackTimer=undefined;if(this.active!==task)return;
        try{this.finish(task,analyzeUnit(task.rows,task.source));}catch(error){this.finish(task,undefined,error as Error);}
      },0);return;
    }
    try{
    if(!this.worker){
      const worker=this.worker=new Worker(new URL('./analysis-worker.ts',import.meta.url),{type:'module'});
      worker.onmessage=event=>{const task=this.active;if(this.worker!==worker||!task||event.data.id!==task.id)return;this.finish(task,event.data.result,event.data.error?Error(event.data.error):undefined);};
      worker.onerror=()=>{if(this.worker===worker)this.fail(Error('Source mapping worker failed'));};
    }
    this.worker.postMessage({id:task.id,rows:task.rows,source:task.source});
    }catch(error){this.fail(error as Error);}
  }
  private finish(task:Task,result?:UnitAnalysis,error?:Error){
    if(this.active!==task)return;this.active=null;
    if(error){if(this.cache.get(task.unit)?.result===task.result)this.cache.delete(task.unit);task.reject(error);}else task.resolve(result!);
    this.pump();
  }
  private fail(error:Error){
    this.worker?.terminate();this.worker=null;
    clearTimeout(this.fallbackTimer);this.fallbackTimer=undefined;
    this.active?.reject(error);this.active=null;
    for(const task of this.queued.values())task.reject(error);this.queued.clear();this.cache.clear();
  }
}

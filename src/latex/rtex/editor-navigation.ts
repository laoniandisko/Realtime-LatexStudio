/** Rebase the parent paragraph's caret after editing a nested formula. */
export function selectionAfterEdit(before:string,after:string,start:number,end=start){
  let from=0,oldEnd=before.length,newEnd=after.length;
  while(from<oldEnd&&from<newEnd&&before[from]===after[from])from++;
  while(oldEnd>from&&newEnd>from&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
  const map=(point:number)=>Math.max(0,Math.min(after.length,point<=from?point:point>=oldEnd?point+newEnd-oldEnd:newEnd));
  return {start:map(start),end:map(end)};
}

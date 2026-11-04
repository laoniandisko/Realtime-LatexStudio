export type ResizeHandle='n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw';
export interface ResizeBox {x:number;y:number;w:number;h:number}
/** Coordinates share the page's units. Edge handles affect one axis; corners can
 * retain the original ratio, including when the pointer moves vertically only. */
export function resizeGesture(start:ResizeBox,handle:ResizeHandle,dx:number,dy:number,locked:boolean,minW=1,minH=1):ResizeBox{
  let w=start.w,h=start.h;
  if(handle.includes('e'))w+=dx;
  if(handle.includes('w'))w-=dx;
  if(handle.includes('s'))h+=dy;
  if(handle.includes('n'))h-=dy;
  const corner=handle.length===2;
  if(corner&&locked){
    const rx=w/start.w,ry=h/start.h,ratio=Math.max(minW/start.w,minH/start.h,Math.min(8,Math.abs(rx-1)>=Math.abs(ry-1)?rx:ry));
    w=start.w*ratio;h=start.h*ratio;
  }else{w=Math.max(minW,Math.min(start.w*8,w));h=Math.max(minH,Math.min(start.h*8,h));}
  return {x:handle.includes('w')?start.x+start.w-w:start.x,y:handle.includes('n')?start.y+start.h-h:start.y,w,h};
}

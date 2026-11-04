/** A reused page canvas must never inherit the last glyph's TeX-space transform.
 * Keep the raster in device pixels, and contain every overlay's drawing state. */
export function paintRasterFrame(context:CanvasRenderingContext2D,base:CanvasImageSource,width:number,height:number,overlays:()=>void){
  context.setTransform(1,0,0,1,0,0);
  context.globalAlpha=1;context.globalCompositeOperation='source-over';context.filter='none';
  context.shadowBlur=0;context.shadowOffsetX=0;context.shadowOffsetY=0;context.shadowColor='rgba(0,0,0,0)';
  context.clearRect(0,0,width,height);context.drawImage(base,0,0);
  context.save();
  try{overlays();}finally{context.restore();}
}

import type { BlockTarget } from './block-edit';
import { resizeGraphicAxes, resizeTable, tableSetting, tableValues, type ObjectRegion } from './object-edit';
import { resizeGesture, type ResizeHandle, type ResizeBox } from './resize-gesture';
import { SP_PER_BP } from './vendor/protocol';

interface Options {
  target: BlockTarget; region: ObjectRegion; page: HTMLElement;
  edit(from:number,to:number,expected:string,replacement:string):boolean;
  boundary():void; close():void; jump():void; notify(message:string):void;
  graphicx?():boolean;
  moveStart?(event:DragEvent):boolean;moveEnd?():void;moveReason?:string;
}
const button=(label:string,title:string)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.title=title;return b;};

/** Input and resize handles survive preview repaints. Pointer motion only changes
 * a cropped-page preview; committing a gesture produces one source edit. */
export class PageObjectEditor {
  readonly element=document.createElement('div');
  readonly target:BlockTarget;
  current:string;
  private box:ObjectRegion;
  private toolbar=document.createElement('div');
  private widthInput=document.createElement('input');
  private heightInput=document.createElement('input');
  private ghost:HTMLDivElement|null=null;
  private image:HTMLCanvasElement|null=null;
  private ghostBox:ResizeBox|null=null;
  private closed=false;
  private dragging=false;
  private moving=false;
  private locked=true;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending:(()=>void)|null=null;
  private pendingRefresh:{region:ObjectRegion;snapshot:string;page?:HTMLElement}|null=null;
  private readonly outside=(event:PointerEvent)=>{if(!this.element.contains(event.target as Node))this.close();};

  constructor(private options:Options){
    this.target=options.target;this.current=this.target.text;this.box={...options.region};
    const element=this.element;element.className='rtex-object-editor';element.dataset.blockKey=this.target.file+':'+this.target.from;
    element.setAttribute('aria-label',this.box.kind==='image'?'图片调整':'表格调整');
    const toolbar=this.toolbar;toolbar.className='rtex-object-tools';
    const label=document.createElement('span');label.className='rtex-object-kind';label.textContent=this.box.kind==='image'?'图片':'表格';toolbar.append(label);
    const move=button(options.moveReason?(/标题|导言/.test(options.moveReason)?'标题绑定':'特殊结构'):'⠿ 移动',options.moveReason||'拖动整张图表，放到段落或图表前后');move.className='rtex-object-move';
    move.draggable=!!options.moveStart;move.setAttribute('aria-label','移动整张图表');
    move.ondragstart=event=>this.startMove(event);move.ondragend=()=>this.endMove();toolbar.append(move);
    const surface=document.createElement('div');surface.className='rtex-object-move-surface';surface.draggable=!!options.moveStart;
    surface.title=options.moveReason||'拖动整张图表换位置；拖四角或边中点调整大小';surface.ondragstart=event=>this.startMove(event);surface.ondragend=()=>this.endMove();element.append(surface);
    const down=button('−','整体缩小 10%'),up=button('+','整体放大 10%');down.onclick=()=>this.changeDimensions({x:1,y:1},.9);up.onclick=()=>this.changeDimensions({x:1,y:1},1.1);toolbar.append(down,up);
    for(const [labelText,input,axis] of [['宽',this.widthInput,'x'],['高',this.heightInput,'y']] as const){
      const field=document.createElement('label');field.textContent=labelText;input.className='rtex-object-dimension';input.type='number';input.min='6';input.max='5000';input.step='1';input.title='PDF 点（bp）';input.setAttribute('aria-label',labelText+'度（bp）');
      input.onchange=()=>{
        const value=Number(input.value)*SP_PER_BP;if(!Number.isFinite(value)||value<6*SP_PER_BP){this.position();return;}
        const ratio=value/(axis==='x'?this.box.w:this.box.h),factors=this.locked?{x:ratio,y:ratio}:{x:axis==='x'?ratio:1,y:axis==='y'?ratio:1};
        this.changeDimensions(factors);
      };field.append(input);toolbar.append(field);
    }
    const lock=button('等比','角柄与数值输入保持比例；按 Shift 临时切换。边柄单独调整宽或高。');lock.setAttribute('aria-pressed','true');
    lock.onclick=()=>{this.locked=!this.locked;lock.textContent=this.locked?'等比':'自由';lock.setAttribute('aria-pressed',String(this.locked));};toolbar.append(lock);
    if(this.box.kind==='table'){
      const values=tableValues(this.current);
      for(const [name,labelText,value,min,max,step] of [['columns','列距',values.columns,.5,24,.5],['rows','行距',values.rows,.6,3,.05]] as const){
        const field=document.createElement('label');field.className='rtex-table-spacing';field.textContent=labelText;const input=document.createElement('input');input.type='number';input.value=String(value);input.min=String(min);input.max=String(max);input.step=String(step);input.setAttribute('aria-label',name==='columns'?'表格列间距（pt）':'表格行距倍数');
        const apply=()=>{try{this.write(tableSetting(this.current,name,Number(input.value)));}catch(error){options.notify((error as Error).message);}};
        input.oninput=()=>{clearTimeout(this.timer);this.pending=apply;this.timer=setTimeout(()=>this.flush(),180);};input.onchange=()=>{clearTimeout(this.timer);this.pending=apply;this.flush();};field.append(input);toolbar.append(field);
      }
    }
    const source=button('源码','定位此图片或表格的源码');source.onclick=()=>{this.close();options.jump();};const close=button('×','结束调整');close.onclick=()=>this.close();toolbar.append(source,close);element.append(toolbar);
    const names:Record<ResizeHandle,string>={n:'上边',ne:'右上角',e:'右边',se:'右下角',s:'下边',sw:'左下角',w:'左边',nw:'左上角'};
    for(const name of Object.keys(names) as ResizeHandle[]){
      const handle=button('',`拖动${names[name]}缩放${this.box.kind==='image'?'图片':'表格'}；角柄等比，Shift 切换`);
      handle.className='rtex-resize-handle'+(name==='se'?' rtex-image-resize':'');handle.dataset.handle=name;handle.setAttribute('aria-label',`从${names[name]}缩放`);handle.onpointerdown=event=>this.beginResize(event,handle,name);element.append(handle);
    }
    options.page.append(element);this.position();document.addEventListener('pointerdown',this.outside);toolbar.onpointerdown=event=>event.stopPropagation();
  }
  startMove(event:DragEvent){
    this.flush();if(this.dragging||!this.options.moveStart?.(event)){event.preventDefault();return;}
    this.moving=true;
    this.makeGhost();if(this.image&&event.dataTransfer?.setDragImage)event.dataTransfer.setDragImage(this.image,Math.min(40,this.image.width/2),Math.min(30,this.image.height/2));
  }
  endMove(){this.moving=false;this.clearGhost();this.applyDeferred();this.options.moveEnd?.();}
  private factor(){return (Number(this.options.page.style.getPropertyValue('--scale-factor'))||1)/SP_PER_BP;}
  private dimensions(){
    if(document.activeElement!==this.widthInput)this.widthInput.value=(this.box.w/SP_PER_BP).toFixed(1);
    if(document.activeElement!==this.heightInput)this.heightInput.value=(this.box.h/SP_PER_BP).toFixed(1);
  }
  private position(){
    const f=this.factor();this.element.style.cssText=`left:${this.box.x*f}px;top:${this.box.y*f}px;width:${this.box.w*f}px;height:${this.box.h*f}px;`;this.dimensions();
    const available=this.options.page.clientWidth-12;this.toolbar.style.maxWidth=available+'px';
    const width=this.toolbar.offsetWidth||Math.min(available,480),height=this.toolbar.offsetHeight||32;
    this.toolbar.style.left=Math.min(0,available-this.box.x*f-width)+'px';this.toolbar.style.top=(this.box.y*f>height+8?-height-6:this.box.h*f+8)+'px';
  }
  private beginResize(event:PointerEvent,handle:HTMLElement,name:ResizeHandle){
    if(event.button!==undefined&&event.button!==0)return;
    event.preventDefault();event.stopPropagation();this.flush();
    const x=event.clientX,y=event.clientY,start={...this.box},f=this.factor();let next:ResizeBox={...start};this.dragging=true;this.makeGhost();handle.setPointerCapture(event.pointerId);
    const cleanup=()=>{handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;this.dragging=false;};
    handle.onpointermove=e=>{next=resizeGesture(start,name,(e.clientX-x)/f,(e.clientY-y)/f,this.locked!==!!e.shiftKey,6*SP_PER_BP,6*SP_PER_BP);this.preview(next);};
    handle.onpointerup=e=>{
      if(Number.isFinite(e?.clientX)&&Number.isFinite(e?.clientY))next=resizeGesture(start,name,(e.clientX-x)/f,(e.clientY-y)/f,this.locked!==!!e.shiftKey,6*SP_PER_BP,6*SP_PER_BP);
      cleanup();this.commitDimensions(next,start);this.applyDeferred();
    };
    handle.onpointercancel=()=>{cleanup();this.clearGhost();this.position();this.applyDeferred();};
  }
  private flush(){clearTimeout(this.timer);const action=this.pending;this.pending=null;action?.();}
  private write(next:string){
    if(next===this.current)return true;this.options.boundary();
    if(!this.options.edit(this.target.from,this.target.from+this.current.length,this.current,next)){this.options.notify('源码已改变，请重新选择此对象。');this.close();return false;}
    this.current=next;this.options.boundary();return true;
  }
  private changeDimensions(factors:{x:number;y:number},uniform=1){const start={...this.box};this.commitDimensions({...start,w:start.w*factors.x*uniform,h:start.h*factors.y*uniform},start);}
  private commitDimensions(next:ResizeBox,start:ObjectRegion){
    const factors={x:next.w/start.w,y:next.h/start.h};
    if(Math.abs(factors.x-1)<.000001&&Math.abs(factors.y-1)<.000001){this.clearGhost();this.position();return;}
    try{
      let source:string;
      if(this.box.kind==='image')source=resizeGraphicAxes(this.current,factors,{widthBp:start.w/SP_PER_BP,heightBp:start.h/SP_PER_BP});
      else {const result=resizeTable(this.current,factors,{widthBp:start.w/SP_PER_BP,heightBp:start.h/SP_PER_BP});if(result.requiresGraphicx&&!this.options.graphicx?.())throw Error('表格整体缩放需要 graphicx。请在导言区加入 \\usepackage{graphicx}。');source=result.text;}
      this.makeGhost();if(!this.write(source))return;this.box={...start,...next};this.preview(this.box);this.dimensions();
    }catch(error){this.clearGhost();this.position();this.options.notify((error as Error).message);}
  }
  private makeGhost(){
    if(this.ghost)return;const source=this.options.page.querySelector('canvas');if(!source)return;
    const factor=this.factor(),dpr=source.width/this.options.page.clientWidth,w=this.box.w*factor,h=this.box.h*factor;
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(w*dpr));canvas.height=Math.max(1,Math.ceil(h*dpr));
    canvas.getContext('2d')!.drawImage(source,this.box.x*factor*dpr,this.box.y*factor*dpr,w*dpr,h*dpr,0,0,canvas.width,canvas.height);
    const ghost=document.createElement('div');ghost.className='rtex-object-ghost';ghost.append(canvas);this.options.page.append(ghost);this.ghost=ghost;this.image=canvas;this.ghostBox={...this.box};this.preview(this.box);
  }
  private preview(next:ResizeBox){
    if(!this.ghost)this.makeGhost();const f=this.factor(),original=this.ghostBox;
    if(this.ghost&&this.image&&original){
      const left=Math.min(original.x,next.x),top=Math.min(original.y,next.y),right=Math.max(original.x+original.w,next.x+next.w),bottom=Math.max(original.y+original.h,next.y+next.h);
      this.ghost.style.cssText=`left:${left*f}px;top:${top*f}px;width:${(right-left)*f}px;height:${(bottom-top)*f}px;`;
      this.image.style.cssText=`position:absolute;left:${(next.x-left)*f}px;top:${(next.y-top)*f}px;width:${next.w*f}px;height:${next.h*f}px;`;
    }
    this.element.style.cssText=`left:${next.x*f}px;top:${next.y*f}px;width:${next.w*f}px;height:${next.h*f}px;`;
  }
  private clearGhost(){this.ghost?.remove();this.ghost=null;this.image=null;this.ghostBox=null;}
  private applyDeferred(){const update=this.pendingRefresh;this.pendingRefresh=null;if(update)this.refresh(update.region,update.snapshot,update.page);}
  refresh(region:ObjectRegion,snapshot:string,page?:HTMLElement){
    if(this.closed||snapshot!==this.current)return;if(this.dragging||this.moving){this.pendingRefresh={region,snapshot,page};return;}
    if(page&&page!==this.options.page){this.options.page=page;page.append(this.element);}this.box={...region};this.clearGhost();this.position();
  }
  close(){if(this.closed)return;this.closed=true;this.flush();document.removeEventListener('pointerdown',this.outside);this.clearGhost();this.element.remove();this.options.close();}
}

export type ChatContent=string|Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string;detail?:'auto'}}>;
export interface ChatMessage {role:string;content:ChatContent}
interface Attachment {id:number;file:File;url:string}
export class ChatImages {
  private images:Attachment[]=[];private nextId=0;
  constructor(private container:HTMLElement,private notify:(message:string)=>void){}
  get count(){return this.images.length;}
  add(files:File[]){
    for(const file of files){
      if(!/^image\/(?:png|jpeg|webp|gif)$/.test(file.type)){this.notify('图片请使用 PNG、JPEG、WebP 或 GIF。');continue;}
      if(file.size>6*1024*1024){this.notify('单张图片最多 6 MiB。');continue;}
      if(this.images.length>=6||this.images.reduce((n,i)=>n+i.file.size,0)+file.size>12*1024*1024){this.notify('每条消息最多 6 张图片，总计最多 12 MiB。');break;}
      this.images.push({id:++this.nextId,file,url:URL.createObjectURL(file)});
    }this.draw();
  }
  paste(event:ClipboardEvent){
    const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
    if(!files.length)return;event.preventDefault();this.add(files);
    const text=event.clipboardData?.getData('text/plain'),input=event.target as HTMLTextAreaElement;
    if(text)input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
  }
  async capture(){
    const selected=[...this.images];const parts=await Promise.all(selected.map(async image=>{
      const url=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('读取图片失败，请重新粘贴。'));reader.readAsDataURL(image.file);});
      return {type:'image_url' as const,image_url:{url,detail:'auto' as const}};
    }));return {parts,consume:()=>{const ids=new Set(selected.map(image=>image.id));for(const image of this.images)if(ids.has(image.id))URL.revokeObjectURL(image.url);this.images=this.images.filter(image=>!ids.has(image.id));this.draw();}};
  }
  clear(){for(const image of this.images)URL.revokeObjectURL(image.url);this.images=[];this.draw();}
  private draw(){
    this.container.replaceChildren();this.container.classList.toggle('hidden',!this.images.length);
    for(const image of this.images){const tile=document.createElement('div'),preview=document.createElement('img'),remove=document.createElement('button');tile.className='chat-image-attachment';preview.src=image.url;preview.alt=image.file.name||'粘贴的图片';remove.type='button';remove.textContent='×';remove.title='移除图片';remove.setAttribute('aria-label','移除图片');remove.onclick=()=>{URL.revokeObjectURL(image.url);this.images=this.images.filter(item=>item.id!==image.id);this.draw();};tile.append(preview,remove);this.container.append(tile);}
  }
}

/** Keep recent image turns within the request limit; earlier textual context is retained. */
export function boundedChatHistory(messages:ChatMessage[]):ChatMessage[]{
  let bytes=0;
  return messages.slice(-20).reverse().map(message=>{
    if(typeof message.content==='string')return message;
    const content:Exclude<ChatContent,string>=[];
    for(const part of message.content){if(part.type==='text')content.push(part);else if(bytes+part.image_url.url.length<=17*1024*1024){bytes+=part.image_url.url.length;content.push(part);}else content.push({type:'text',text:'[较早的图片本轮未重新附带]'});}
    return {...message,content};
  }).reverse();
}

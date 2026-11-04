export interface WorkspaceIdentity{id:string|null;root:string;token:string}
/** A scoped editor may renew its capability after a restart, but never change roots. */
export async function workspaceRequest(url:string,init:RequestInit,getIdentity:()=>WorkspaceIdentity,setToken:(token:string)=>void,fetcher:typeof fetch=fetch):Promise<Response>{
 if(!url.startsWith('/__latex/'))throw Error('Invalid workspace API URL.');
 const identity=getIdentity();
 const send=()=>{const headers=new Headers(init.headers);headers.set('X-LaTeX-Token',getIdentity().token);return fetcher(url,{...init,headers});};
 let response=await send();
 if(response.status!==403||!identity.id||!identity.root)return response;
 const fresh=await fetcher('/__latex/session?project='+encodeURIComponent(identity.id),{signal:init.signal});
 const session=await fresh.json(),current=getIdentity();
 if(!fresh.ok||!session.token)throw Error(session.error||'项目会话无法恢复，请返回主页重新打开。');
 if(current.id!==identity.id||current.root!==identity.root||session.root!==identity.root)throw Error('项目目录已改变，已保留当前编辑内容，请返回主页重新打开。');
 setToken(session.token);response=await send();return response;
}

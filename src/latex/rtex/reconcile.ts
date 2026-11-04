/** Retain untouched hit targets, including a pointer's first click of a double-click. */
export function reconcileNodes(parent:Node,nodes:Node[]) {
  const wanted=new Set(nodes);
  for(const node of [...parent.childNodes])if(!wanted.has(node))parent.removeChild(node);
  let cursor=parent.firstChild;
  for(const node of nodes){if(node===cursor)cursor=cursor.nextSibling;else parent.insertBefore(node,cursor);}
}

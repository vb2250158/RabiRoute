/** Provider protocol history, distinct from display messages and long-term memory. */
export function snapshotModelContext(value=[]){
 if(!Array.isArray(value)||value.length>256||value.some(item=>!item||!['user','assistant'].includes(item.role)||typeof item.content!=='string'||item.content.length>256000))throw Error('ASSISTANT_MODEL_CONTEXT_INVALID');
 const history=value.map(({role,content})=>({role,content}));
 while(history.length>24||history.reduce((n,item)=>n+item.content.length,0)>64000)history.shift();
 while(history[0]?.role==='assistant')history.shift();
 return history;
}

// Lazy previews share one lane, leaving the QQ reader available for navigation.
let tail:Promise<unknown>=Promise.resolve();
export function qqPreviewRead<T>(signal:AbortSignal,read:()=>Promise<T>):Promise<T>{
  const pending=tail.then(()=>{signal.throwIfAborted();return read();});
  tail=pending.catch(()=>undefined);
  return pending;
}

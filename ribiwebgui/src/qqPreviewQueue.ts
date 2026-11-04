function createReadLane(){
  let tail:Promise<unknown>=Promise.resolve();
  return function queueRead<T>(signal:AbortSignal,read:()=>Promise<T>):Promise<T>{
    const pending=tail.then(()=>{signal.throwIfAborted();return read();});
    tail=pending.catch(()=>undefined);
    return pending;
  };
}
// At most one navigation read and one preview read; previews never block navigation.
export const qqNavigationRead=createReadLane();
export const qqPreviewRead=createReadLane();

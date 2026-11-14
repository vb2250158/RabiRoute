import { sha256 } from "@noble/hashes/sha256";
/** Hash an explicit file selection off the UI thread; no network or retained file data. */
self.onmessage = async (event: MessageEvent<Blob>) => {
 const reader=event.data.stream().getReader();const hash=sha256.create();
 try {while(true){const item=await reader.read();if(item.done)break;hash.update(item.value);}self.postMessage({sha256:Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,"0")).join("")});}
 catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
 finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
};

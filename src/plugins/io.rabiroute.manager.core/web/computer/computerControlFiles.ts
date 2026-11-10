import { sha256 as sha256Bytes } from "@noble/hashes/sha256";
import { COMPUTER_LIMITS } from "@shared/agentInteractiveProtocol";
export type ComputerFileCall = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type ComputerFileProgress = { uploadId?: string; path: string; size: number; offset: number; state: string; sha256?: string };
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2,"0")).join("");
async function sha256(bytes: Uint8Array): Promise<string> { return hex(sha256Bytes(bytes)); }
async function fileHash(file: Blob, signal: AbortSignal): Promise<string> {
 if (typeof Worker === "undefined") { const hash=sha256Bytes.create();const reader=file.stream().getReader();try{while(true){if(signal.aborted)throw new DOMException("已停止文件校验。","AbortError");const value=await reader.read();if(value.done)break;hash.update(value.value);}return hex(hash.digest());}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();} }
 const worker=new Worker(new URL("./computerControlHashWorker.ts",import.meta.url),{type:"module"});
 return new Promise((resolve,reject)=>{const abort=()=>{worker.terminate();reject(new DOMException("已停止文件校验。","AbortError"));};signal.addEventListener("abort",abort,{once:true});
 const finish=()=>{signal.removeEventListener("abort",abort);worker.terminate();};worker.onmessage=event=>{finish();event.data.error?reject(new Error(event.data.error)):resolve(event.data.sha256);};worker.onerror=event=>{finish();reject(new Error(event.message));};if(signal.aborted)abort();else worker.postMessage(file);});
}
function base64(bytes: Uint8Array): string { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
/** Browser adapter for the existing upload/read wire protocol. The target owns durable transfer state. */
export class ComputerControlFiles {
  constructor(private readonly call: ComputerFileCall) {}
  async upload(file: Blob, path: string, uploadId: string, signal: AbortSignal, progress: (value: ComputerFileProgress) => void) {
    const hash = await fileHash(file, signal);
    const check = () => { if (signal.aborted) throw new DOMException("上传等待已停止；请查询原传输或明确取消。", "AbortError"); }; check();
    let current = await this.call({ action:"upload.begin", uploadId, path, size:file.size, sha256:hash });
    progress(current as ComputerFileProgress);
    while (Number(current.offset) < file.size) {
      check(); const offset = Number(current.offset); const part = new Uint8Array(await file.slice(offset, Math.min(offset + Number(COMPUTER_LIMITS.chunkBytes), file.size)).arrayBuffer());
      current = await this.call({ action:"upload.write", uploadId, offset, data:base64(part), sha256:await sha256(part) }); progress(current as ComputerFileProgress);
    }
    check(); current = await this.call({action:"upload.commit",uploadId}); progress(current as ComputerFileProgress); return current;
  }
  async download(path: string, signal: AbortSignal, progress: (value: ComputerFileProgress) => void): Promise<Blob> {
    const info = await this.call({action:"file.stat",path}); let offset = 0; const chunks: BlobPart[] = [];
    while (offset < Number(info.size)) {
      if (signal.aborted) throw new DOMException("下载已停止。", "AbortError");
      const result = await this.call({action:"file.read",path,version:info.version,offset}); const bytes = unbase64(String(result.data));
      if (await sha256(bytes) !== result.sha256 || Number(result.offset) !== offset || Number(result.nextOffset) !== offset + bytes.length || result.version !== info.version) throw new Error("文件分块校验不一致，未保存下载文件。");
      chunks.push(bytes as BlobPart); offset = Number(result.nextOffset); progress({path,size:Number(info.size),offset,state:offset === Number(info.size) ? "verified" : "reading"});
      if (!bytes.length && offset < Number(info.size)) throw new Error("文件读取没有继续推进，请按原版本检查。");
    }
    return new Blob(chunks);
  }
}

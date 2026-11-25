export type DraftRecord<T> = { revision: number; value: T | null; title: string };

export function restoreMediaComputeSelection(value: { modelComputeDeviceId?: string; serviceDeviceId?: string }) {
  const modelDeviceId = typeof value.modelComputeDeviceId === "string" ? value.modelComputeDeviceId : undefined;
  const legacyDeviceId = typeof value.serviceDeviceId === "string" ? value.serviceDeviceId : "";
  return { deviceId: modelDeviceId ?? "", pendingImageDeviceId: modelDeviceId ?? legacyDeviceId };
}

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || '项目保存服务不可用。');
  return value;
}
async function encode(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return new Promise((resolve,reject) => {
    const reader=new FileReader(); reader.onload=()=>resolve({__rabiAudio:String(reader.result)}); reader.onerror=reject;reader.readAsDataURL(value);
  });
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value==='object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await encode(item)])));
  return value;
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value==='object') {
    const data=(value as {__rabiAudio?:string}).__rabiAudio;
    if(typeof data==='string' && /^data:audio\/[a-z0-9.+-]+;base64,/i.test(data)) {
      const [header,content]=data.split(','); const raw=atob(content!);
      return new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:header!.slice(5,-7)});
    }
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decode(item)]));
  }
  return value;
}
function draftPath(key:string,canvasId?:string) { return canvasId ? `/api/video/v2/projects/${encodeURIComponent(key)}/canvases/${encodeURIComponent(canvasId)}/editor` : `/api/video/projects/${encodeURIComponent(key)}`; }
export async function readDraft<T>(key: string,canvasId?:string, signal = AbortSignal.timeout(15000)): Promise<DraftRecord<T>> {
  const record=await api(draftPath(key,canvasId), { signal });
  return {...record,value:decode(record.value)};
}
export async function writeDraft<T>(key: string,value:T,revision:number,title:string,canvasId?:string):Promise<number> {
  const record=await api(draftPath(key,canvasId),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:await encode(value),revision,title})});
  return record.revision;
}

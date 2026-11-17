import fs from 'node:fs';
import { agentMessagePreview, agentMessageTime, codexVisibleMessage } from '../../../shared/agentSessionMessages.js';
import { readCodexRolloutLines, statCodexRollout } from './codexRolloutReader.js';

type Preview = {preview:string;lastMessageTime?:string};
type Thread = {id:string;rolloutPath:string};
const CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function fromLine(line:string):Preview|undefined {
  try {
    const record = JSON.parse(line);
    const visible = codexVisibleMessage(record);
    if (!visible?.text.trim()) return undefined;
    const time = agentMessageTime(record.timestamp);
    return {preview:agentMessagePreview(visible.text),...(time ? {lastMessageTime:time} : {})};
  } catch { return undefined; }
}
function stamp(stat:fs.Stats):string {
  return [stat.dev,stat.ino,stat.birthtimeMs,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
}

/** Plain ledgers seek backwards; archived ledgers stream once per immutable file revision. */
export class CodexSessionPreviewReader {
  private readonly cache = new Map<string,{stamp:string;value:Preview|undefined}>();
  async read(thread:Thread, signal?:AbortSignal):Promise<Preview|undefined> {
    if (!thread.rolloutPath) return undefined;
    try {
      signal?.throwIfAborted();
      const source = await statCodexRollout(thread.rolloutPath);
      const key = thread.id+'\0'+source.physicalPath, revision = stamp(source.stat);
      const cached = this.cache.get(key);
      if (cached?.stamp === revision) return cached.value;
      let value:Preview|undefined;
      if (source.fallback || source.physicalPath.endsWith('.zst')) {
        for await (const line of readCodexRolloutLines(thread.rolloutPath,thread.id,{signal,requireTerminatedRecords:true})) {
          value = fromLine(line) || value;
        }
      } else value = await this.backwards(source.physicalPath,source.stat.size,signal);
      const current = await statCodexRollout(thread.rolloutPath);
      if (current.physicalPath === source.physicalPath && stamp(current.stat) === revision) {
        this.cache.delete(key);this.cache.set(key,{stamp:revision,value});
        if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      }
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  private async backwards(file:string,size:number,signal?:AbortSignal):Promise<Preview|undefined> {
    const handle = await fs.promises.open(file,'r');
    try {
      let end = size, suffix = Buffer.alloc(0), skipTail = true;
      while (end > 0) {
        signal?.throwIfAborted();
        const start = Math.max(0,end-CHUNK_BYTES), chunk = Buffer.allocUnsafe(end-start);
        const {bytesRead} = await handle.read(chunk,0,chunk.length,start);
        const bytes = Buffer.concat([chunk.subarray(0,bytesRead),suffix]);
        let boundary = bytes.length;
        for (let index=bytes.length-1;index>=0;index--) {
          if (bytes[index] !== 10) continue;
          if (skipTail) skipTail = false;
          else {
            const result = fromLine(bytes.subarray(index+1,boundary).toString('utf8'));
            if (result) return result;
          }
          boundary = index;
        }
        suffix = Buffer.from(bytes.subarray(0,boundary));
        if (suffix.length > MAX_RECORD_BYTES) return undefined;
        end = start;
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      return skipTail ? undefined : fromLine(suffix.toString('utf8'));
    } finally { await handle.close(); }
  }
}

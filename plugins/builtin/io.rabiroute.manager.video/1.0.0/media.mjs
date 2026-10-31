import { checkedFs } from "./requestAccess.mjs";
import { createReadStream } from "node:fs";

export async function openMedia(request, file, mime, filename, access, dependencies = {}) {
  const fs = dependencies.fs ?? checkedFs(access); access?.assert();
  const { size } = await fs.stat(file);
  access?.assert();
  const range = request.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    const suffix = parsed && !parsed[1];
    if (parsed && (parsed[1] || parsed[2])) {
      start = suffix ? Math.max(0, size - Number(parsed[2])) : Number(parsed[1]);
      end = suffix || !parsed[2] ? size - 1 : Math.min(Number(parsed[2]), size - 1);
    } else start = size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      return { status: 416, headers: { "content-range": `bytes */${size}` }, frames: (async function* () {})(), cancel: async () => {} };
    }
  }
  access?.assert();
  const headers = {
    "content-type": mime, "content-length": String(end - start + 1),
    "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    ...(filename ? { "content-disposition": `inline; filename="${filename}"` } : {}),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {})
  };
  access?.assert();
  dependencies.signal?.throwIfAborted();
  const source = (dependencies.createReadStream ?? createReadStream)(file, { start, end });
  let cancelled = false; const closed = new Promise(resolve => source.once("close", resolve));
  source.on("error", () => {});
  const cancel = async () => { cancelled = true; dependencies.signal?.removeEventListener("abort", aborted); source.destroy(); await closed; };
  const aborted = () => { void cancel(); }; dependencies.signal?.addEventListener("abort", aborted, { once: true });
  if (dependencies.signal?.aborted) aborted();
  const frames = (async function* () {
    try { for await (const chunk of source) { if (cancelled) return; access?.assert(); yield Buffer.from(chunk); } if (!cancelled) access?.assert(); }
    catch (error) { if (!cancelled) throw error; }
    finally { dependencies.signal?.removeEventListener("abort", aborted); source.destroy(); await closed; }
  })();
  return { status: range ? 206 : 200, headers, frames, cancel };
}

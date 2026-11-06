type ObjectRead = (owner: string, id: string) => Promise<Buffer>;
type Authorize = () => void;

/** Each storage owner keeps its integrity and identity checks; missing media does not erase an event. */
export async function readRecordingObject(
  owner: string,
  id: string,
  cache: ObjectRead,
  archive: ObjectRead,
  authorize?: Authorize
): Promise<Buffer | undefined> {
  for (const read of [cache, archive]) {
    authorize?.();
    let bytes: Buffer;
    try { bytes = await read(owner, id); }
    catch { authorize?.(); continue; }
    authorize?.();
    return bytes;
  }
  return undefined;
}

export async function readRecordingAudio(
  owner: string,
  chunks: readonly string[],
  read: (owner: string, id: string, authorize?: Authorize) => Promise<Buffer | undefined>,
  authorize?: Authorize
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const id of chunks) {
    authorize?.();
    const part = await read(owner, id, authorize);
    authorize?.();
    if (part) parts.push(part);
  }
  authorize?.();
  if (!parts.length) throw new Error("Recording audio unavailable");
  return Buffer.concat(parts);
}

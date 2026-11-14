import fs from "node:fs";
import * as zlib from "node:zlib";

const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

export type CodexRolloutSource = {
  physicalPath: string;
  stat: fs.Stats;
  fallback: boolean;
};

type DestroyableReadWriteStream = NodeJS.ReadWriteStream & AsyncIterable<Buffer | string> & {
  destroy(error?: Error): void;
};

const createZstdDecompress = (zlib as typeof zlib & {
  createZstdDecompress?: () => DestroyableReadWriteStream;
}).createZstdDecompress;

function exactSibling(filePath: string): string | undefined {
  if (filePath.endsWith(".jsonl.zst")) return filePath.slice(0, -4);
  if (filePath.endsWith(".jsonl")) return filePath + ".zst";
  return undefined;
}

export async function statCodexRollout(recordedPath: string): Promise<CodexRolloutSource> {
  try {
    return { physicalPath: recordedPath, stat: await fs.promises.stat(recordedPath), fallback: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const sibling = exactSibling(recordedPath);
    if (!sibling) throw error;
    try {
      return { physicalPath: sibling, stat: await fs.promises.stat(sibling), fallback: true };
    } catch (siblingError) {
      if ((siblingError as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw siblingError;
    }
  }
}

function sourceError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function provesTaskIdentity(line: string, expectedThreadId: string): boolean {
  try {
    const record = JSON.parse(line.replace(/^\uFEFF/, "")) as {
      type?: unknown;
      payload?: { id?: unknown };
    };
    return record.type === "session_meta" && record.payload?.id === expectedThreadId;
  } catch {
    return false;
  }
}

/**
 * Read the exact Codex task ledger in either hot JSONL or archived Zstandard form.
 * The recorded path stays authoritative; only ENOENT permits its one exact sibling.
 */
export async function* readCodexRolloutLines(
  recordedPath: string,
  expectedThreadId: string,
  options: {
    signal?: AbortSignal;
    verifyIdentity?: boolean;
    requireTerminatedRecords?: boolean;
    onSource?: (source: CodexRolloutSource) => void;
    /** Resume a plain JSONL stream at an earlier returned complete-record boundary. */
    startOffset?: number;
    onLine?: (line: string, position: { startOffset: number; nextOffset: number; terminated: boolean }) => void;
  } = {}
): AsyncGenerator<string> {
  const startOffset = options.startOffset ?? 0;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) throw sourceError("Invalid rollout byte offset.", "CODEX_ROLLOUT_OFFSET_INVALID");
  const deadline = AbortSignal.timeout(DEFAULT_SCAN_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  let handle: fs.promises.FileHandle;
  let physicalPath = recordedPath;
  let fallback = false;
  try {
    handle = await fs.promises.open(recordedPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const sibling = exactSibling(recordedPath);
    if (!sibling) throw error;
    try {
      handle = await fs.promises.open(sibling, "r");
      physicalPath = sibling;
      fallback = true;
    } catch (siblingError) {
      if ((siblingError as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw siblingError;
    }
  }

  const stat = await handle.stat().catch(async error => {
    await handle.close();
    throw error;
  });
  if (!stat.isFile()) {
    await handle.close();
    throw sourceError(`Codex rollout is not a regular file: ${physicalPath}`, "CODEX_ROLLOUT_NOT_FILE");
  }

  if (startOffset > 0) {
    try {
      if (physicalPath.endsWith(".zst") || startOffset > stat.size) throw sourceError("The rollout cursor no longer addresses a plain file.", "CODEX_ROLLOUT_CURSOR_CHANGED");
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        signal.throwIfAborted();
        const bytes = Buffer.alloc(4096);
        const read = await handle.read(bytes, 0, bytes.length, offset);
        const end = bytes.subarray(0, read.bytesRead).indexOf(10);
        chunks.push(bytes.subarray(0, end < 0 ? read.bytesRead : end));
        if (end >= 0 || !read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (!provesTaskIdentity(Buffer.concat(chunks).toString("utf8"), expectedThreadId)) throw sourceError("The rollout cursor belongs to another task.", "CODEX_ROLLOUT_IDENTITY_MISMATCH");
    } catch (error) { await handle.close(); throw error; }
  }
  try { options.onSource?.({ physicalPath, stat, fallback }); }
  catch (error) { await handle.close(); throw error; }
  const source = handle.createReadStream({ autoClose: true, signal, start: startOffset });
  let input: AsyncIterable<Buffer | string> = source;
  let decompressor: DestroyableReadWriteStream | undefined;
  let failDecompressor: ((error: Error) => void) | undefined;
  let abortDecompressor: (() => void) | undefined;
  if (physicalPath.endsWith(".zst")) {
    if (!createZstdDecompress) {
      source.destroy();
      throw sourceError("This Node runtime cannot read Zstandard Codex rollouts.", "CODEX_ROLLOUT_ZSTD_UNSUPPORTED");
    }
    decompressor = createZstdDecompress();
    failDecompressor = (error: Error): void => decompressor?.destroy(error);
    abortDecompressor = (): void => failDecompressor?.(signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError"));
    source.once("error", failDecompressor);
    signal.addEventListener("abort", abortDecompressor, { once: true });
    input = source.pipe(decompressor);
  }

  let first = startOffset === 0;
  let nextOffset = startOffset;
  let pendingParts: Buffer<ArrayBufferLike>[] = [];
  let pendingBytes = 0;
  const accept = (lineBytes: Buffer, terminated = true): string => {
    const normalized = lineBytes.at(-1) === 13 ? lineBytes.subarray(0, -1) : lineBytes;
    const line = normalized.toString("utf8");
    if (first) {
      first = false;
      if ((fallback || options.verifyIdentity) && !provesTaskIdentity(line, expectedThreadId)) {
        throw sourceError("The exact Codex rollout sibling does not belong to the requested task.", "CODEX_ROLLOUT_IDENTITY_MISMATCH");
      }
    }
    const previousOffset = nextOffset;
    nextOffset += lineBytes.length + (terminated ? 1 : 0);
    options.onLine?.(line, { startOffset: previousOffset, nextOffset, terminated });
    return line;
  };
  try {
    for await (const chunk of input) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      let newline: number;
      while ((newline = bytes.indexOf(10, start)) >= 0) {
        signal.throwIfAborted();
        const tail = bytes.subarray(start, newline);
        const lineLength = pendingBytes + tail.length;
        const lineBytes = pendingParts.length
          ? Buffer.concat([...pendingParts, tail], lineLength)
          : tail;
        pendingParts = [];
        pendingBytes = 0;
        yield accept(lineBytes);
        start = newline + 1;
      }
      if (start < bytes.length) {
        const tail = bytes.subarray(start);
        pendingParts.push(tail);
        pendingBytes += tail.length;
      }
    }
    signal.throwIfAborted();
    if (pendingBytes) {
      if (options.requireTerminatedRecords) {
        throw sourceError("Codex rollout ended with an incomplete record.", "CODEX_ROLLOUT_INCOMPLETE_RECORD");
      }
      const pending = pendingParts.length === 1 ? pendingParts[0]! : Buffer.concat(pendingParts, pendingBytes);
      yield accept(pending, false);
    }
    if ((fallback || options.verifyIdentity) && first) {
      throw sourceError("The exact Codex rollout sibling has no complete identity record.", "CODEX_ROLLOUT_IDENTITY_MISSING");
    }
  } finally {
    if (failDecompressor) source.removeListener("error", failDecompressor);
    if (abortDecompressor) signal.removeEventListener("abort", abortDecompressor);
    decompressor?.destroy();
    source.destroy();
  }
}

import fs from "node:fs";
import * as zlib from "node:zlib";

const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
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
  } = {}
): AsyncGenerator<string> {
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

  options.onSource?.({ physicalPath, stat, fallback });
  const source = handle.createReadStream({ autoClose: true, signal });
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

  let first = true;
  let pendingParts: Buffer<ArrayBufferLike>[] = [];
  let pendingBytes = 0;
  const accept = (lineBytes: Buffer): string => {
    const limit = (fallback || options.verifyIdentity) && first ? MAX_IDENTITY_BYTES : MAX_RECORD_BYTES;
    if (lineBytes.length > limit) {
      throw sourceError(`Codex rollout record exceeds ${limit} bytes.`, "CODEX_ROLLOUT_RECORD_TOO_LARGE");
    }
    const normalized = lineBytes.at(-1) === 13 ? lineBytes.subarray(0, -1) : lineBytes;
    const line = normalized.toString("utf8");
    if (first) {
      first = false;
      if ((fallback || options.verifyIdentity) && !provesTaskIdentity(line, expectedThreadId)) {
        throw sourceError("The exact Codex rollout sibling does not belong to the requested task.", "CODEX_ROLLOUT_IDENTITY_MISMATCH");
      }
    }
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
        const limit = (fallback || options.verifyIdentity) && first ? MAX_IDENTITY_BYTES : MAX_RECORD_BYTES;
        if (lineLength > limit) {
          throw sourceError(`Codex rollout record exceeds ${limit} bytes.`, "CODEX_ROLLOUT_RECORD_TOO_LARGE");
        }
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
      const limit = (fallback || options.verifyIdentity) && first ? MAX_IDENTITY_BYTES : MAX_RECORD_BYTES;
      if (pendingBytes > limit) {
        throw sourceError(`Codex rollout record exceeds ${limit} bytes.`, "CODEX_ROLLOUT_RECORD_TOO_LARGE");
      }
    }
    signal.throwIfAborted();
    if (pendingBytes) {
      if (options.requireTerminatedRecords) {
        throw sourceError("Codex rollout ended with an incomplete record.", "CODEX_ROLLOUT_INCOMPLETE_RECORD");
      }
      const pending = pendingParts.length === 1 ? pendingParts[0]! : Buffer.concat(pendingParts, pendingBytes);
      yield accept(pending);
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

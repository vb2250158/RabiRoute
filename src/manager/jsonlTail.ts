import fs from "node:fs";

export type JsonlTailOptions = {
  initialBytes?: number;
  maxBytes?: number;
};

export function readJsonlTail(
  filePath: string,
  limit = 8,
  options: JsonlTailOptions = {}
): Array<Record<string, unknown>> {
  const requested = Math.max(0, Math.floor(limit));
  if (requested === 0 || !fs.existsSync(filePath)) return [];
  let descriptor: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const initialBytes = Math.max(4 * 1024, Math.floor(options.initialBytes ?? 64 * 1024));
    const maxBytes = Math.max(initialBytes, Math.floor(options.maxBytes ?? 1024 * 1024));
    descriptor = fs.openSync(filePath, "r");
    let bytes = Math.min(stat.size, initialBytes);
    let lines: string[] = [];
    while (true) {
      const start = Math.max(0, stat.size - bytes);
      const buffer = Buffer.allocUnsafe(stat.size - start);
      const read = fs.readSync(descriptor, buffer, 0, buffer.byteLength, start);
      lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift();
      lines = lines.filter(Boolean);
      if (lines.length >= requested || start === 0 || bytes >= maxBytes) break;
      bytes = Math.min(stat.size, maxBytes, bytes * 4);
    }
    return lines.slice(-requested).map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { rawLine: line };
      }
    });
  } catch (error) {
    return [{
      error: error instanceof Error ? error.message : String(error),
      path: filePath
    }];
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

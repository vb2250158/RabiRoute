import { createHash } from "node:crypto";
import type { BotNativeResult } from "./protocol.js";

export type BotLargeFileInput = { name: string; fileType: number; base64: string };
const partitionHashSize = 10_002_432;

export function parseLargeFile(input: BotLargeFileInput): Required<BotLargeFileInput> & { bytes: Buffer } {
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length || bytes.length > 32 * 1024 * 1024 || bytes.toString("base64") !== input.base64) {
    throw new Error("附件内容须为有效 Base64，大小上限 32 MiB。");
  }
  return { ...input, bytes };
}

export async function uploadLargeFile(
  root: string,
  input: ReturnType<typeof parseLargeFile>,
  request: (pathname: string, body: Record<string, unknown>) => Promise<BotNativeResult>,
  assertCurrent: () => void,
  signal: AbortSignal,
  put: typeof fetch = fetch
): Promise<BotNativeResult> {
  const hash = (name: string, data: Buffer) => createHash(name).update(data).digest("hex");
  const bytes = input.bytes;
  const prepared = await request(root + "/upload_prepare", {
    file_type: input.fileType, file_name: input.name, file_size: bytes.length,
    md5: hash("md5", bytes), sha1: hash("sha1", bytes), md5_10m: hash("md5", bytes.subarray(0, partitionHashSize))
  });
  if (prepared.status >= 300) return prepared;
  const plan = prepared.data as { upload_id?: string; block_size?: number; parts?: Array<{ index: number; presigned_url: string }> } | null;
  const size = plan?.block_size ?? 0;
  if (!plan?.upload_id || !Number.isSafeInteger(size) || size < 1 || !Array.isArray(plan.parts)
    || plan.parts.length !== Math.ceil(bytes.length / size) || plan.parts.length > 2048
    || new Set(plan.parts.map(part => part.index)).size !== plan.parts.length) throw new Error("腾讯返回的附件分片计划无效。");
  for (const part of plan.parts) {
    assertCurrent();
    const url = new URL(part.presigned_url);
    if (!Number.isSafeInteger(part.index) || part.index < 1 || part.index > plan.parts.length || url.protocol !== "https:"
      || url.username || url.password) throw new Error("腾讯附件上传地址无效。");
    const block = bytes.subarray((part.index - 1) * size, part.index * size);
    const response = await put(url, { method: "PUT", body: new Uint8Array(block), redirect: "error", signal });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`腾讯附件分片上传失败（HTTP ${response.status}）。`);
    const result = await request(root + "/upload_part_finish", {
      upload_id: plan.upload_id, part_index: part.index, block_size: block.length, md5: hash("md5", block)
    });
    if (result.status >= 300) return result;
  }
  return request(root + "/files", { upload_id: plan.upload_id });
}

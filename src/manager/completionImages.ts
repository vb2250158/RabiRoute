import fs from "node:fs";
import { createInterface } from "node:readline";
import { getTimeoutMs } from "../shared/timeoutSettings.js";

/** Read only native generated-image outputs from the exact completed turn, never user or screenshot inputs. */
export async function readCodexTurnImages(rolloutPath: string, turnId: string, onImageError: (error: Error) => void = () => {}): Promise<string[]> {
  const size = (await fs.promises.stat(rolloutPath)).size;
  if (!size || !turnId) return [];
  const stream = fs.createReadStream(rolloutPath, { encoding: "utf8", end: size - 1,
    signal: AbortSignal.timeout(getTimeoutMs("backend.agentRequests.rolloutReceipt.readRolloutUserMessages.AbortSignal.timeout.request", 30000)) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const images = new Set<string>();
  try {
    for await (const line of lines) {
      if (!line.includes('image_gen.generation') || !line.includes(turnId)) continue;
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload, item = payload?.item;
      if (record.type !== "event_msg" || payload.type !== "item_completed" || payload.turn_id !== turnId
        || item?.type !== "Extension" || item.kind !== "image_gen.generation" || item.status !== "completed" || typeof item.result !== "string") continue;
      const bytes = Buffer.from(item.result.replace(/^data:image\/[^;]+;base64,/, ""), "base64");
      const extension = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : undefined;
      if (!extension) { onImageError(new Error("Native generated image has an unsupported or invalid image format.")); continue; }
      images.add(`base64://${bytes.toString("base64")}`);
    }
    return [...images];
  } finally { lines.close(); stream.destroy(); }
}

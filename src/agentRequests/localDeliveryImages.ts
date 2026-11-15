import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type LocalDeliveryImage = { path: string; sha256: string };

/** Local attachment references are content-bound to the original delivery, never transferred to another PC. */
export function normalizeLocalDeliveryImages(value: unknown): LocalDeliveryImage[] {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error("Select one to eight local image attachments.");
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Object.keys(raw).some(key => !["path", "sha256"].includes(key))
      || typeof raw.path !== "string" || raw.path.length > 32768 || !path.isAbsolute(raw.path) || /[\u0000-\u001f]/.test(raw.path)
      || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw new Error("Invalid local image attachment reference.");
    return { path: raw.path, sha256: raw.sha256 };
  });
}

function imageHash(file: string): string {
  const descriptor = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 12 || stat.size > 16 * 1024 * 1024) throw new Error("Image attachment must be a file of at most 16 MiB.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Image attachment changed during reading.");
      offset += count;
    }
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) throw new Error("Image attachment must be PNG, JPEG or WebP.");
    return createHash("sha256").update(bytes).digest("hex");
  } finally { fs.closeSync(descriptor); }
}

export function snapshotLocalDeliveryImages(paths: unknown): LocalDeliveryImage[] {
  if (!Array.isArray(paths)) throw new Error("imagePaths must be an array.");
  const references = normalizeLocalDeliveryImages(paths.map(file => ({ path: file, sha256: "0".repeat(64) })));
  return references.map(reference => ({ ...reference, sha256: imageHash(reference.path) }));
}

export function verifyLocalDeliveryImages(value: unknown): string[] {
  return normalizeLocalDeliveryImages(value).map(reference => {
    if (imageHash(reference.path) !== reference.sha256) throw new Error("Image attachment changed after the delivery was prepared; the original message was not sent.");
    return reference.path;
  });
}

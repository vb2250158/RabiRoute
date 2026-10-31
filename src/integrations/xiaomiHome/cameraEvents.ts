import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CameraEvent = Readonly<{
  eventId: string;
  cameraId: string;
  adapterId: string;
  occurredAt: string;
  kind: string;
  resourceId: string;
}>;

export type CameraEventAdapter<Input> = Readonly<{
  id: string;
  event(input: Input): CameraEvent | undefined;
}>;

export function cameraEventId(adapterId: string, cameraId: string, occurredAt: string, kind: string): string {
  if (![adapterId, cameraId, kind].every(value => value.trim()) || !Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("Camera event identity is incomplete.");
  }
  return `camera-event-${createHash("sha256").update(JSON.stringify([adapterId, cameraId, new Date(occurredAt).toISOString(), kind])).digest("hex")}`;
}

function safeComponent(value: string): string {
  if (!value || value === "." || value === ".." || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid camera path component.");
  const encoded = encodeURIComponent(value).replaceAll(".", "%2E");
  if (encoded.length > 180 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(encoded)) throw new Error("Invalid camera path component.");
  return encoded;
}

export function cameraClipPath(roleDirectory: string, event: CameraEvent): string {
  if (!path.isAbsolute(roleDirectory)) throw new Error("Camera role directory must be absolute.");
  const timestamp = new Date(event.occurredAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid camera event time.");
  const root = path.resolve(roleDirectory);
  const camera = safeComponent(event.cameraId);
  const eventName = safeComponent(event.eventId);
  const parts = ["camera", camera, timestamp.toISOString().slice(0, 10)];
  let directory = root;
  for (const part of [undefined, ...parts]) {
    if (part !== undefined) {
      directory = path.join(directory, part);
      try { fs.mkdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe camera directory.");
  }
  const target = path.join(directory, `${eventName}.mp4`);
  if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error("Unsafe camera clip.");
  return target;
}

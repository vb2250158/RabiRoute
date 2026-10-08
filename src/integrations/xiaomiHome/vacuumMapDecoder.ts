import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CELLS = 4 * 1024 * 1024;
const IV = Buffer.from("ABCDEF1234123412", "ascii");

/** pv11cn official plugin v61 MapParser and APP_CONFIG; not inferred from room colors. */
export const vacuumGridContracts: Readonly<Record<string, { unknown: number[]; wall: number[]; floor: number[]; roomGridRange: number[]; additionalBits: { hidden: number; unreachable: number; carpet: number; object: number } }>> = {
  "xiaomi.vacuum.pv11cn": { unknown: [0], wall: [1], floor: [2], roomGridRange: [3, 255], additionalBits: { hidden: 1, unreachable: 2, carpet: 4, object: 8 } }
};

function base64(value: unknown): Buffer {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid map Base64.");
  return Buffer.from(value, "base64");
}

function finite(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e9 || positive && value <= 0) throw new Error("Invalid map geometry.");
  return value;
}

/** Version-2 JSON family. Structural decode does not prove pose freshness or navigation. */
export function decodeXiaomiVacuumMap(raw: Buffer, model: string, deviceId: string) {
  if (!raw.length || raw.length > MAX_BYTES || !/^[\x20-\x7e]{16,128}$/.test(model) || !/^\d{1,32}$/.test(deviceId)) throw new Error("Invalid bounded map identity/input.");
  const envelope = JSON.parse(raw.toString("utf8"));
  if (envelope?.version !== 2) throw new Error("Unsupported map envelope.");
  const encrypted = base64(envelope.data);
  if (encrypted.length % 16) throw new Error("Invalid map AES blocks.");
  const modelKey = Buffer.from(model.slice(-16), "ascii");
  const derivation = createCipheriv("aes-128-cbc", modelKey, IV);
  const material = Buffer.concat([derivation.update(Buffer.concat([modelKey, Buffer.from(deviceId)])), derivation.final()]);
  const key = createHash("md5").update(material).digest();
  const decipher = createDecipheriv("aes-128-cbc", key, IV);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const map = JSON.parse(inflateSync(compressed, { maxOutputLength: MAX_BYTES }).toString("utf8")) as Record<string, any>;
  if (!map || Array.isArray(map) || typeof map !== "object") throw new Error("Invalid map object.");
  const width = finite(map.width, true), height = finite(map.height, true);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > MAX_CELLS) throw new Error("Map grid exceeds bounds.");
  const cells = inflateSync(base64(map.map_data), { maxOutputLength: MAX_CELLS });
  if (cells.length !== width * height) throw new Error("Map grid size mismatch.");
  const additional = map.additional_map_data === undefined || map.additional_map_data === null ? undefined : inflateSync(base64(map.additional_map_data), { maxOutputLength: MAX_CELLS });
  if (additional && additional.length !== cells.length) throw new Error("Additional map grid size mismatch.");
  const originX = finite(map.origin_x), originY = finite(map.origin_y), resolution = finite(map.resolution, true), rotation = finite(map.rotate);
  if (resolution > 10_000) throw new Error("Invalid map resolution.");
  const mapId = finite(map.map_id);
  if (!Number.isInteger(mapId) || mapId < 0) throw new Error("Invalid map ID.");
  const point = (value: unknown): { x: number; y: number; yaw?: number } | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const p = value as Record<string, unknown>;
    return { x: finite(p.x), y: finite(p.y), ...(typeof p.yaw === "number" ? { yaw: finite(p.yaw) } : {}) };
  };
  const robotPosition = point(map.position);
  const dockPosition = map.have_pile === true ? point({ x: map.pile_x, y: map.pile_y, yaw: map.pile_yaw }) : undefined;
  const rooms = Array.isArray(map.room_attrs) ? map.room_attrs.map((room: any) => ({ id: room.id, name: String(room.room_name || "").slice(0, 128), labelPosition: point({ x: room.name_pos_x, y: room.name_pos_y }) })) : [];
  if (rooms.length > 256) throw new Error("Too many map rooms.");
  return {
    decoded: true as const, format: "xiaomi-json-envelope-v2" as const,
    map,
    grid: { encoding: "uint8-row-major" as const, dataBase64: cells.toString("base64"), width, height, mapId,
      originX, originY, resolution, rotation, unit: "millimeters" as const, rowZero: "originY" as const,
      ...(additional ? { additionalDataBase64: additional.toString("base64") } : {}),
      labels: vacuumGridContracts[model], cellSemanticsVerified: Boolean(vacuumGridContracts[model]) },
    rooms, dockPosition, robotPosition,
    poseFreshness: "unverified" as const,
    coordinateNavigation: false as const
  };
}

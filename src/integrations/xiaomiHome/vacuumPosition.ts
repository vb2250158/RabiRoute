/** Official pv11cn v61 spec: read-only vacuum-position property. */
export const vacuumPositionContracts: Readonly<Record<string, { siid: number; piid: number }>> = {
  "xiaomi.vacuum.pv11cn": { siid: 10, piid: 4 }
};

export class VacuumPositionParseError extends Error {
  constructor(readonly reason: "output_type" | "output_size" | "invalid_json" | "coordinate") {
    super(`Invalid position payload: ${reason}.`);
  }
}

/** Empty property is absence; never replace it with a map or trajectory snapshot. */
export function parseVacuumPosition(value: unknown): { x: number; y: number; yaw?: number } | undefined {
  if (typeof value !== "string") throw new VacuumPositionParseError("output_type");
  if (Buffer.byteLength(value) > 4096) throw new VacuumPositionParseError("output_size");
  if (!value.trim()) return undefined;
  let point: unknown;
  try { point = JSON.parse(value); } catch { throw new VacuumPositionParseError("invalid_json"); }
  if (!point || typeof point !== "object" || Array.isArray(point)) throw new VacuumPositionParseError("coordinate");
  const p = point as Record<string, unknown>;
  const coordinate = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9) throw new VacuumPositionParseError("coordinate");
    return v;
  };
  return { x: coordinate(p.x), y: coordinate(p.y), ...(p.yaw === undefined ? {} : { yaw: coordinate(p.yaw) }) };
}

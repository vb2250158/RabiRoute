/** Fixed, read-only wire contracts verified against the official device package. */
export const vacuumTrajectoryContracts: Readonly<Record<string, { siid: number; aiid: number; outputPiid: number }>> = {
  "xiaomi.vacuum.pv11cn": { siid: 2, aiid: 47, outputPiid: 24 }
};

export type VacuumTrajectoryPoint = { poseId: number; x: number; y: number; yaw?: number };
export class VacuumTrajectoryParseError extends Error {
  constructor(readonly reason: "output_type" | "output_size" | "invalid_json" | "object_type" | "points_type" | "points_size" | "point_type" | "pose_id" | "duplicate_pose_id" | "coordinate") {
    super(`Invalid trajectory payload: ${reason}.`);
  }
}

export function parseVacuumTrajectory(output: unknown): VacuumTrajectoryPoint[] {
  if (typeof output !== "string") throw new VacuumTrajectoryParseError("output_type");
  if (Buffer.byteLength(output, "utf8") > 128 * 1024) throw new VacuumTrajectoryParseError("output_size");
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new VacuumTrajectoryParseError("invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VacuumTrajectoryParseError("object_type");
  const points = (value as Record<string, unknown>).points;
  if (!Array.isArray(points)) throw new VacuumTrajectoryParseError("points_type");
  if (points.length > 1024) throw new VacuumTrajectoryParseError("points_size");
  const seen = new Set<number>();
  const coordinate = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e9) throw new VacuumTrajectoryParseError("coordinate");
    return value;
  };
  return points.map(point => {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new VacuumTrajectoryParseError("point_type");
    const poseId = point.pose_id;
    if (!Number.isInteger(poseId) || poseId < 0 || poseId > 2147483647) throw new VacuumTrajectoryParseError("pose_id");
    if (seen.has(poseId)) throw new VacuumTrajectoryParseError("duplicate_pose_id");
    seen.add(poseId);
    return { poseId, x: coordinate(point.x), y: coordinate(point.y), ...(point.yaw === undefined ? {} : { yaw: coordinate(point.yaw) }) };
  }).sort((a, b) => a.poseId - b.poseId);
}

import {createHash} from "node:crypto";
import type {VacuumTrajectoryPoint} from "./vacuumTrajectory.js";

export type VacuumFeedbackMap = {
  decoded: boolean; sha256: string; slot: string;
  device: {deviceId: string; model: string};
  grid?: {mapId: number; originX: number; originY: number; resolution: number; rotation: number; width: number; height: number};
  map?: Record<string, any>;
};

export type VacuumFeedbackResult = {
  state: "sample" | "unavailable" | "map_changed_during_read";
  source: "get-vacuum-route"; observedAt: string; reset: boolean;
  scope?: string; mapId?: number; taskId?: number; queryPoseId?: number;
  baselinePoseId?: number; nextPoseId?: number; newPointCount: number;
  position?: VacuumTrajectoryPoint;
  coordinateUnit: "millimeters"; yawUnit: "milliradians";
  poseFreshness: "unverified"; coordinateNavigation: false;
};

/** A read continuation belongs to an account, device, task and coordinate frame.
 * It is a reconstruction hint, never an authorization or navigation capability. */
export function vacuumFeedbackIdentity(map: VacuumFeedbackMap, region: string, account: string) {
  const g = map.grid, cursor = map.map?.paths?.pose_id, taskId = map.map?.task_id;
  if (!map.decoded || !g || !Number.isSafeInteger(taskId) || taskId < 0 ||
      !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 2147483647) return undefined;
  const scope = createHash("sha256").update(JSON.stringify([account, region,
    map.device.deviceId, map.device.model, map.slot, g.mapId, taskId,
    g.originX, g.originY, g.resolution, g.rotation, g.width, g.height])).digest("hex");
  return {scope, mapId: g.mapId, taskId: taskId as number, mapPoseId: cursor as number};
}

export function prepareVacuumFeedback(identity: NonNullable<ReturnType<typeof vacuumFeedbackIdentity>>,
  previousScope: string, previousPoseId: number) {
  const reset = identity.scope !== previousScope;
  const baselinePoseId = reset ? identity.mapPoseId : Math.max(identity.mapPoseId, previousPoseId);
  return {...identity, reset, baselinePoseId, queryPoseId: Math.max(0, baselinePoseId - 1)};
}

/** Bracket the trajectory with two map identities; never merge across tasks.
 * Advancing a cursor proves receipt of new points, not device sampling latency. */
export function consumeVacuumFeedback(prepared: ReturnType<typeof prepareVacuumFeedback>,
  after: ReturnType<typeof vacuumFeedbackIdentity>, points: VacuumTrajectoryPoint[], observedAt: string): VacuumFeedbackResult {
  const common = {source: "get-vacuum-route" as const, observedAt,
    coordinateUnit: "millimeters" as const, yawUnit: "milliradians" as const,
    poseFreshness: "unverified" as const, coordinateNavigation: false as const};
  if (!after || after.scope !== prepared.scope) return {...common,
    state: "map_changed_during_read" as const, reset: true, newPointCount: 0};
  const baselinePoseId = Math.max(prepared.baselinePoseId, after.mapPoseId);
  const latest = points.at(-1);
  const newPoints = points.filter(point => point.poseId > baselinePoseId);
  // The map may already be newer than the returned trajectory tail.
  const position = latest && latest.poseId >= after.mapPoseId ? latest : undefined;
  return {...common, state: position ? "sample" as const : "unavailable" as const,
    scope: after.scope, mapId: after.mapId, taskId: after.taskId,
    reset: prepared.reset, queryPoseId: prepared.queryPoseId, baselinePoseId,
    nextPoseId: Math.max(baselinePoseId, latest?.poseId ?? baselinePoseId),
    newPointCount: newPoints.length, ...(position ? {position} : {})};
}

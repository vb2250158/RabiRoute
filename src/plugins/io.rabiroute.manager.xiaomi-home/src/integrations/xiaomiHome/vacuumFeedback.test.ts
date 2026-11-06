import assert from "node:assert/strict";
import test from "node:test";
import {vacuumFeedbackIdentity, prepareVacuumFeedback, consumeVacuumFeedback, type VacuumFeedbackMap} from "./vacuumFeedback.js";

function map(taskId = 1, cursor = 84): VacuumFeedbackMap {
  return {decoded: true, sha256: "a".repeat(64), slot: "0",
    device: {deviceId: "123", model: "fixture"}, map: {task_id: taskId, paths: {pose_id: cursor}},
    grid: {mapId: 1, originX: 0, originY: 0, resolution: 50, rotation: 0, width: 100, height: 100}};
}
const identity = (m: VacuumFeedbackMap) => vacuumFeedbackIdentity(m, "cn", "fixture-account")!;
const points = [{poseId: 83, x: 0, y: 0}, {poseId: 84, x: 0, y: 0}, {poseId: 85, x: 10, y: 0, yaw: 0}];

test("feedback overlap consumes points once, keeps zero heading and does not claim navigation", () => {
  const m = identity(map()), first = prepareVacuumFeedback(m, "", 999);
  assert.equal(first.baselinePoseId, 84); assert.equal(first.queryPoseId, 83);
  const result = consumeVacuumFeedback(first, m, points, "2020-01-01T00:00:00Z");
  assert.equal(result.newPointCount, 1); assert.equal(result.position?.yaw, 0);
  assert.equal(result.coordinateNavigation, false); assert.equal(result.poseFreshness, "unverified");
  const second = prepareVacuumFeedback(m, result.scope!, result.nextPoseId!);
  assert.equal(consumeVacuumFeedback(second, m, points, "2020-01-01T00:00:02Z").newPointCount, 0);
});
test("account, region, device, task, slot and coordinate frame isolate continuations", () => {
  const original = map(), originalScope = identity(original).scope;
  const changes = [map(2), {...original, slot: "1"}, {...original, device: {...original.device, deviceId: "456"}},
    {...original, grid: {...original.grid!, originX: 100}}];
  for (const changed of changes) {
    const after = identity(changed); assert.notEqual(after.scope, originalScope);
    assert.equal(prepareVacuumFeedback(after, originalScope, 9000).baselinePoseId, after.mapPoseId);
  }
  assert.notEqual(vacuumFeedbackIdentity(original, "de", "fixture-account")!.scope, originalScope);
  assert.notEqual(vacuumFeedbackIdentity(original, "cn", "other-account")!.scope, originalScope);
});
test("task changes across a read discard old trajectory, even when pose IDs match", () => {
  const prepared = prepareVacuumFeedback(identity(map()), "", 0);
  const result = consumeVacuumFeedback(prepared, identity(map(2)), points, "2020-01-01T00:00:00Z");
  assert.equal(result.state, "map_changed_during_read"); assert.equal(result.position, undefined);
  assert.equal(result.scope, undefined); assert.equal(result.newPointCount, 0);
});
test("missing task/cursor invalidates feedback; newer maps cannot be replaced by older trajectory", () => {
  const missing = map(); delete missing.map!.paths;
  assert.equal(identity(missing), undefined);
  const prepared = prepareVacuumFeedback(identity(map()), "", 0);
  const result = consumeVacuumFeedback(prepared, identity(map(1, 90)), points, "2020-01-01T00:00:00Z");
  assert.equal(result.state, "unavailable"); assert.equal(result.position, undefined);
  assert.equal(result.nextPoseId, 90); assert.equal(result.newPointCount, 0);
});
test("a regressed same-task map cannot lower an already consumed cursor", () => {
  const current = identity(map(1, 80));
  const prepared = prepareVacuumFeedback(current, current.scope, 92);
  const result = consumeVacuumFeedback(prepared, current, [{poseId: 91, x: 0, y: 0}, {poseId: 92, x: 0, y: 0}], "2020-01-01T00:00:00Z");
  assert.equal(result.newPointCount, 0); assert.equal(result.nextPoseId, 92);
});

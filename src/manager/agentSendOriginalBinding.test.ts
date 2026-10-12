import assert from "node:assert/strict";
import test from "node:test";
import { projectOriginalAgentSendBinding, safeOriginalBindingMissingFields } from "./agentSendOriginalBinding.js";

const expected = { deliveryId: "example-delivery", deliveryRequestDigest: "example-digest", routeId: "example-route", groupId: "100001", instanceId: "example-instance" };
const data = { ...expected, routeProfileId: expected.routeId, ok: true, status: "sent", sentFileId: "example-file", selfId: "100002", bindingRevision: "example-revision" };

test("original matched upload fields project an immutable binding only", () => {
  const result = projectOriginalAgentSendBinding({ ...data, path: "private-path", text: "private-body", token: "private-token" }, expected);
  assert.equal(result.state, "present");
  if (result.state !== "present") assert.fail("original binding expected");
  assert.deepEqual(result.binding, { routeId: "example-route", instanceId: "example-instance", groupId: "100001", platformFileId: "example-file", selfId: "100002", bindingRevision: "example-revision" });
  assert.equal(Object.isFrozen(result.binding), true);
});
test("old upload cannot borrow missing selfId or revision from nested request or current fields", () => {
  const { selfId, bindingRevision, ...old } = data;
  assert.deepEqual(projectOriginalAgentSendBinding({ ...old, request: data, currentBinding: data }, expected), {
    state: "missing", missingFields: ["selfId", "bindingRevision"]
  });
});
test("identity, original target, malformed and conflicting binding fields fail closed", () => {
  for (const change of [{ deliveryId: "other" }, { deliveryRequestDigest: "other" }, { routeProfileId: "other" },
    { instanceId: "other" }, { groupId: "100003" }, { selfId: "private-body" }, { selfId: 100002 },
    { bindingRevision: "bad\nrevision" }, { folderId: "../secret" }, { status: "failed" }]) {
    assert.equal(projectOriginalAgentSendBinding({ ...data, ...change }, expected).state, "conflict");
  }
  assert.deepEqual(safeOriginalBindingMissingFields(["selfId", "private-path", "token", "bindingRevision"]), ["selfId", "bindingRevision"]);
  assert.deepEqual(projectOriginalAgentSendBinding({ ...data, routeProfileId: "", groupId: "", instanceId: "", selfId: "", bindingRevision: null }, expected), {
    state: "missing", missingFields: ["routeProfileId", "instanceId", "groupId", "selfId", "bindingRevision"]
  });
});

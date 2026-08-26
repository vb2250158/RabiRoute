/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { sameWebPluginModuleInstances } from "./pluginModules";

test("same Bundle revision reactivates when its active instance membership changes", () => {
  const before = [{ instanceId: "manager:core" }, { instanceId: "manager:persona" }];
  assert.equal(sameWebPluginModuleInstances(before, [...before].reverse()), true);
  assert.equal(sameWebPluginModuleInstances(before, [{ instanceId: "manager:core" }]), false);
  assert.equal(sameWebPluginModuleInstances(before, [{ instanceId: "manager:core" }, { instanceId: "manager:desktop" }]), false);
});

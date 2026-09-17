import assert from "node:assert/strict";
import test from "node:test";
import { routeAgentOperationGuard } from "../src/routeAgentOperationGuard";

test("changing route or same-provider target during an await stops subsequent side effects", async () => {
  for (const replacement of [{ gatewayId: "other", targetId: "remote:a:codex" }, { gatewayId: "route", targetId: "remote:b:codex" }]) {
    let selected = { gatewayId: "route", targetId: "remote:a:codex" };
    const guard = routeAgentOperationGuard(selected.gatewayId, selected.targetId, () => selected);
    const effects: string[] = [];
    const run = async () => {
      guard();
      effects.push("save-original");
      await Promise.resolve().then(() => { selected = replacement; });
      guard();
      effects.push("create");
    };
    await assert.rejects(run(), /已切换/);
    assert.deepEqual(effects, ["save-original"]);
  }
});

test("unchanged route and target can continue after awaited work", async () => {
  const selected = { gatewayId: "route", targetId: "local:codex" };
  const guard = routeAgentOperationGuard(selected.gatewayId, selected.targetId, () => selected);
  guard();
  await Promise.resolve();
  assert.doesNotThrow(guard);
});

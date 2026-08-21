import assert from "node:assert/strict";
import test from "node:test";
import { adapterConfigItem } from "./controlPlaneRoutes.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

test("adapter config persistence keeps the DSH owner binding", () => {
  const item = adapterConfigItem({
    id: "XinghaiBuilder-main",
    configName: "XinghaiBuilder-main",
    enabled: true,
    messageAdapters: ["heartbeat"],
    agentAdapters: ["dsh"],
    primaryAgentAdapter: "dsh",
    dshSessionId: "session-00000000-0000-4000-8000-000000000041",
    dshSessionName: "星海建造师（DSH 主人格）",
    dshCwd: "C:/Data/CottonProject/PangHu",
    dshBaseUrl: "http://127.0.0.1:3080"
  } as GatewayDefinition);

  assert.equal(item.dshSessionId, "session-00000000-0000-4000-8000-000000000041");
  assert.equal(item.dshSessionName, "星海建造师（DSH 主人格）");
  assert.equal(item.dshCwd, "C:/Data/CottonProject/PangHu");
  assert.equal(item.dshBaseUrl, "http://127.0.0.1:3080");
});

import assert from "node:assert/strict";
import test from "node:test";
import { authorizeAgentApiOperation, listAgentApiOperations } from "./agentApiPolicy.js";

test("home directory search, pagination and details are discoverable through the same Agent catalog", () => {
  for (const path of ["/devices?q=书房&kind=climate&available=1&view=summary&offset=0&limit=5", "/resources?deviceId=ac&q=温度&limit=5", "/devices/ac"]) {
    assert.equal(authorizeAgentApiOperation("GET", "/api/agent/xiaomi-home" + path).allowed, true);
  }
  const entry = listAgentApiOperations().find(item => item.pathTemplate === "/api/agent/xiaomi-home/devices")!;
  assert.deepEqual(entry.queryParameters, ["q", "kind", "available", "view", "offset", "limit"]);
  assert.match(entry.description, /nextOffset/);
});

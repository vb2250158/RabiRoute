import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHomeAssistantState, XiaomiHomeManagerApiClient } from "./managerApi.js";
import { deviceDirectory } from "./deviceDirectory.js";
import { parseHomeDirectoryQuery, queryHomeDevices, filterHomeResources, homeDirectoryPage, homeResourceSummary } from "./directoryQuery.js";

const query = (value = "", scope: "devices" | "resources" = "resources") => parseHomeDirectoryQuery(new URLSearchParams(value), scope);
const resources = [
  normalizeHomeAssistantState({ entity_id: "climate.study", state: "cool", attributes: { friendly_name: "书房空调", description: "西侧变频机", current_temperature: 25, nested: { room: "楼上" } } }),
  normalizeHomeAssistantState({ entity_id: "sensor.temperature", state: "25", attributes: { friendly_name: "温度", unit_of_measurement: "°C" } }),
  normalizeHomeAssistantState({ entity_id: "light.offline", state: "unavailable", attributes: { friendly_name: "卧室灯" } }),
  normalizeHomeAssistantState({ entity_id: "script.evening", state: "off" })
];
const directory = deviceDirectory(resources, [
  { deviceId: "ac", entityId: "climate.study", displayName: "同名", model: "Inverter-X", manufacturer: "Demo", areaName: "二楼" },
  { deviceId: "ac", entityId: "sensor.temperature" },
  { deviceId: "lamp", entityId: "light.offline", displayName: "同名" }
]);

test("summary device discovery stays small and searches descriptions, attributes and registry metadata", () => {
  const page = queryHomeDevices(directory, query("q=西侧 楼上&kind=climate", "devices"));
  assert.equal(page.total, 1);
  assert.equal(page.items[0]!.deviceId, "ac");
  assert.equal("resources" in page.items[0]!, false);
  assert.equal(JSON.stringify(page).includes("current_temperature"), false);
  assert.equal(queryHomeDevices(directory, query("q=inverter-x 二楼", "devices")).total, 1);
  assert.equal(queryHomeDevices(directory, query("", "devices")).total, 2);
  assert.equal(page.unassignedResourceCount, 1);
});

test("resource search matches metadata and nested values while type, availability and ownership filter exactly", () => {
  assert.deepEqual(filterHomeResources(resources, query("q=西侧 25&kind=climate&available=1"), directory).map(item => item.entityId), ["climate.study"]);
  assert.equal(filterHomeResources(resources, query("q=INVERTER-X"), directory).length, 2);
  assert.equal(filterHomeResources(resources, query("deviceId=ac"), directory).length, 2);
  assert.deepEqual(filterHomeResources(resources, query("deviceId=unassigned"), directory).map(item => item.entityId), ["script.evening"]);
  assert.equal(filterHomeResources(resources, query("available=0"), directory).length, 1);
  assert.throws(() => filterHomeResources(resources, query("deviceId=missing"), directory), { status: 404 });
  assert.equal(filterHomeResources(resources, query("q=不存在"), directory).length, 0);
});

test("pages traverse 372 resources without omissions and enforce the summary byte budget", () => {
  const items = Array.from({ length: 372 }, (_, id) => ({ id, description: "长名称".repeat(42) }));
  let offset = 0;
  const ids: number[] = [];
  for (;;) {
    const page = homeDirectoryPage(items, query(`offset=${offset}&limit=50`));
    assert.ok(Buffer.byteLength(JSON.stringify(page.items)) < 6100);
    ids.push(...page.items.map(item => item.id));
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.deepEqual(ids, items.map(item => item.id));
  assert.equal(homeDirectoryPage([], query()).nextOffset, null);
  assert.equal(homeDirectoryPage(items, query("offset=999")).items.length, 0);
});

test("query validation rejects ambiguous, excessive and conflicting reads", () => {
  for (const value of ["q=a&q=b", "template=bad", "limit=0", "limit=51", "offset=-1", "offset=1e2", "available=true", "view=all", "includeActions=1&view=summary", "kind=CLIMATE", `q=${"a".repeat(257)}`]) {
    assert.throws(() => query(value), { status: 400 });
  }
  assert.throws(() => query("deviceId=ac", "devices"), { status: 400 });
  assert.equal(query("includeActions=1").view, "detail");
  assert.equal(query().limit, 20);
});

test("resource pages discover action schemas only for the selected page and detail reads stay exact", async () => {
  let serviceReads = 0;
  const client = new XiaomiHomeManagerApiClient({ baseUrl: "http://127.0.0.1:8123" }, (async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/states") return Response.json(resources.map(resource => ({ entity_id: resource.entityId, state: resource.state, attributes: resource.attributes })));
    if (path === "/api/services") { serviceReads++; return Response.json([]); }
    if (path === "/api/states/climate.study") return Response.json({ entity_id: "climate.study", state: "cool", attributes: { current_temperature: 25 } });
    throw Error("Unexpected provider read " + path);
  }) as typeof fetch, "fixture-token");
  const summary = await client.queryResources(query("kind=climate&limit=1"));
  assert.deepEqual(summary.items[0], homeResourceSummary(resources[0]!));
  assert.equal(serviceReads, 0);
  const detailed = await client.queryResources(query("kind=climate&includeActions=1&limit=1"));
  assert.equal(detailed.items.length, 1); assert.equal(serviceReads, 1);
  assert.ok("attributes" in detailed.items[0]!);
  assert.equal((await client.getResource("home:ha:climate.study")).attributes.current_temperature, 25);
});

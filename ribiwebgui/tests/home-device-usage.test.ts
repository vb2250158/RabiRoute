import assert from "node:assert/strict";
import test from "node:test";
import { readDeviceUsage, recordDeviceOpen, rankDevices } from "../src/homeDeviceUsage.js";
function storage() { let value: string | null = null; return { getItem: () => value, setItem: (_key: string, text: string) => { value = text; } }; }
test("opening counts survive reload; frequency precedes recency and ties retain provider order", () => {
 const saved = storage(), devices = ["a", "b", "c", "d"].map(deviceId => ({ deviceId }));
 recordDeviceOpen(saved, "b", 100); recordDeviceOpen(saved, "b", 101); recordDeviceOpen(saved, "c", 200);
 const snapshot = readDeviceUsage(saved);
 assert.deepEqual(rankDevices(devices, snapshot).map(item => item.deviceId), ["b", "c", "a", "d"]);
 recordDeviceOpen(saved, "c", 201);
 assert.deepEqual(rankDevices(devices, snapshot).map(item => item.deviceId), ["b", "c", "a", "d"]);
 assert.deepEqual(rankDevices(devices, readDeviceUsage(saved)).map(item => item.deviceId), ["c", "b", "a", "d"]);
 assert.deepEqual(devices.map(item => item.deviceId), ["a", "b", "c", "d"]);
});
test("invalid stored records are ignored and a fresh open recovers corrupt history", () => {
 const saved = storage(); saved.setItem("", "invalid"); assert.deepEqual(readDeviceUsage(saved), []);
 recordDeviceOpen(saved, "a", 1); assert.deepEqual(readDeviceUsage(saved), [{ deviceId: "a", count: 1, lastOpenedAt: 1 }]);
 saved.setItem("", JSON.stringify({ version: 1, devices: [{ deviceId: "bad", count: -1, lastOpenedAt: 1 }, { deviceId: "a", count: 1, lastOpenedAt: 1 }, { deviceId: "a", count: 3, lastOpenedAt: 2 }] }));
 assert.deepEqual(readDeviceUsage(saved), [{ deviceId: "a", count: 1, lastOpenedAt: 1 }]);
});
test("unavailable browser storage leaves the original display order usable", () => {
 const unavailable = { getItem: () => { throw Error("disabled"); }, setItem: () => { throw Error("disabled"); } };
 assert.doesNotThrow(() => recordDeviceOpen(unavailable, "a", 1));
 assert.deepEqual(rankDevices([{ deviceId: "a" }, { deviceId: "b" }], readDeviceUsage(unavailable)), [{ deviceId: "a" }, { deviceId: "b" }]);
});

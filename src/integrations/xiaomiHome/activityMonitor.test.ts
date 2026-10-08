import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HomeAssistantActivityMonitor, homeAssistantActivityRecord } from "./activityMonitor.js";
import type { HomeAssistantActivityPort, HomeAssistantActivityRecord, HomeAssistantActivityRequest } from "../../shared/homeAssistantActivity.js";

class Socket extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.emit("close"); }
  message(value: unknown) { this.emit("message", JSON.stringify(value)); }
}
function fixture() {
  let listener: (request: HomeAssistantActivityRequest | null) => void = () => {};
  const received: HomeAssistantActivityRecord[] = [], errors: string[] = [], sockets: Socket[] = [];
  const port: HomeAssistantActivityPort = {
    subscribe: callback => { listener = callback; callback(null); return () => { listener = () => {}; }; },
    receive: async (role, entry) => { assert.equal(role, "persona"); received.push(entry); return true; },
    report: (_role, error) => { errors.push(error); }
  };
  const monitor = new HomeAssistantActivityMonitor("http://localhost:8123", {
    port, credentialToken: "test-token", reconnectDelayMs: 1,
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as never; }
  });
  monitor.start();
  return { monitor, received, errors, sockets, request: (value: HomeAssistantActivityRequest | null) => listener(value) };
}
function authorize(socket: Socket) {
  socket.message({ type: "auth_required" }); socket.message({ type: "auth_ok" });
  socket.message({ type: "result", id: 1, success: true, result: [{ entity_id: "sensor.vacuum_progress", attributes: { friendly_name: "Vacuum progress" } }] });
}

test("Activity keeps progress JSON and custom entries with stable identities across name changes", () => {
  const entry = { when: Date.now() / 1000, entity_id: "sensor.vacuum_progress", state: '{"mode":3,"progress":74}', context_id: "context" };
  const record = homeAssistantActivityRecord(entry, new Map([[entry.entity_id, "Vacuum progress"]]))!;
  assert.equal(record.state, entry.state); assert.match(record.text, /progress.*74/);
  assert.equal(record.id, homeAssistantActivityRecord(entry, new Map([[entry.entity_id, "Renamed"]]))!.id);
  assert.notEqual(record.id, homeAssistantActivityRecord({ ...entry, state: '{"progress":76}' }, new Map())!.id);
  assert.equal(homeAssistantActivityRecord({ when: entry.when, name: "Automation", message: "triggered", domain: "automation" }, new Map())!.text, "Automation triggered");
  assert.equal(homeAssistantActivityRecord({ when: "bad", state: "on" }, new Map()), null);
});

test("Activity subscribes only on recording demand, streams backfill and live ordinary states, drains on stop", async () => {
  const f = fixture(); assert.equal(f.sockets.length, 0);
  const startedAt = Date.now() - 1000;
  f.request({ roleId: "persona", startedAt });
  const socket = f.sockets[0]; authorize(socket);
  assert.deepEqual(socket.sent.at(-1), { id: 2, type: "logbook/event_stream", start_time: new Date(startedAt).toISOString() });
  socket.message({ type: "result", id: 2, success: true });
  socket.message({ type: "event", id: 2, event: { partial: true, events: [{ when: startedAt / 1000 - 1, state: "old" }, { when: startedAt / 1000 + 0.2, entity_id: "sensor.vacuum_progress", state: '{"progress":74}' }] } });
  socket.message({ type: "event", id: 2, event: { events: [{ when: Date.now() / 1000, name: "Automation", message: "triggered" }] } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.received.length, 2); assert.match(f.received[0].text, /Vacuum progress/);
  f.request(null);
  socket.message({ type: "event", id: 2, event: { events: [{ when: Date.now() / 1000, state: "off" }] } });
  await f.monitor.stop(); assert.equal(f.received.length, 2); assert.equal(f.monitor.status().recording, false);
});

test("reconnect replays the recording range for owner deduplication; rejected subscriptions surface errors", async () => {
  const f = fixture(), startedAt = Date.now() - 500;
  f.request({ roleId: "persona", startedAt }); authorize(f.sockets[0]);
  f.sockets[0].close(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sockets.length, 2); authorize(f.sockets[1]);
  assert.equal(f.sockets[1].sent.at(-1)?.start_time, new Date(startedAt).toISOString());
  f.sockets[1].message({ type: "result", id: 2, success: false, error: { code: "unknown_command" } });
  assert.equal(f.monitor.status().state, "unavailable"); assert.match(f.errors.at(-1)!, /订阅失败/);
  await f.monitor.stop();
});

test("missing or rejected credentials fail closed without repeated connections", async () => {
  const f = fixture(); f.request({ roleId: "persona", startedAt: Date.now() });
  f.sockets[0].message({ type: "auth_invalid" });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.sockets.length, 1); assert.equal(f.monitor.status().state, "authorization_failed");
  await f.monitor.stop();
});

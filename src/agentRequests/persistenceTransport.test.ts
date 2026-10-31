import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { serialize } from "node:v8";
import { AgentRequestPersistenceTransport } from "./persistenceTransport.js";

test("complete IPC envelopes stay under 32KiB with Unicode, escapes, empty strings and prototype-like JSON keys", { timeout: 10_000 }, async t => {
  const { port1, port2 } = new MessageChannel();
  let maximum = 0, frames = 0, outstanding = 0, peak = 0;
  const original = port1.postMessage.bind(port1);
  t.mock.method(port1, "postMessage", (value: any) => {
    if (value.channel === "agent-request-value") {
      maximum = Math.max(maximum, serialize(value).byteLength + 4); frames++; outstanding++; peak = Math.max(peak, outstanding);
    }
    original(value);
  });
  port1.on("message", (value: any) => { if (value?.channel === "agent-request-ack") outstanding--; });
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const values = new Map<string, unknown>();
  const received = new Promise((yes, no) => { resolve = yes; reject = no; });
  const sender = new AgentRequestPersistenceTransport(port1, () => assert.fail("Unexpected reverse value"), reject);
  const receiver = new AgentRequestPersistenceTransport(port2, (id, value) => { values.set(id, value); if (values.size === 2) resolve(values); }, reject);
  const value = { text: ('\u0000"\\\n\ud800🔭星海').repeat(30_000), empty: "", optional: undefined,
    nested: [null, true, false, 0, -2.5, { original: "preserved" }] };
  Object.defineProperty(value, "__proto__", { value: { own: "preserved" }, enumerable: true });
  try {
    await Promise.all([sender.send("fixture-message-identifier-000000000000", value), sender.send("fixture-message-identifier-111111111111", value)]);
    await received;
    assert.equal(values.size, 2);
    for (const entry of values.values()) assert.deepEqual(entry, value);
    assert.ok(frames > 10); assert.ok(maximum <= 32_768, `Complete native IPC envelope was ${maximum} bytes`);
    assert.equal(peak, 1); assert.equal(outstanding, 0);
  } finally { sender.stop(new Error("Fixture closed")); receiver.stop(new Error("Fixture closed")); port1.close(); port2.close(); }
});

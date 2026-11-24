import assert from "node:assert/strict";
import test from "node:test";
import { subscribeToManagerEvents } from "../src/sharedManagerEvents";

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  withCredentials = false;
  closes = 0;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
    this.dispatchEvent(new MessageEvent("ready", { data: "manager-ready" }));
  }
  close() {
    this.closes++;
    this.readyState = 2;
  }
}

test("Manager event consumers share a connection and independently release their subscriptions", async t => {
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  t.after(() => { globalThis.EventSource = original; });
  const first = subscribeToManagerEvents("/api/events");
  const sibling = subscribeToManagerEvents("/api/events");
  const source = FakeEventSource.instances[0]!;
  assert.equal(FakeEventSource.instances.length, 1);
  source.open();

  const events: string[] = [];
  const late = subscribeToManagerEvents("/api/events");
  late.addEventListener("open", () => events.push("open"));
  late.addEventListener("ready", event => events.push((event as MessageEvent).data));
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.deepEqual(events, ["open", "manager-ready"]);

  first.addEventListener("role_catalog_changed", () => assert.fail("closed consumer received an event"));
  sibling.addEventListener("role_catalog_changed", event => {
    events.push((event as MessageEvent).data);
  }, { once: true });
  first.close();
  source.dispatchEvent(new MessageEvent("role_catalog_changed", { data: "role" }));
  source.dispatchEvent(new MessageEvent("role_catalog_changed", { data: "ignored" }));
  assert.deepEqual(events, ["open", "manager-ready", "role"]);
  assert.equal(first.readyState, first.CLOSED);
  assert.equal(source.closes, 0);
  sibling.close();
  late.close();
  assert.equal(source.closes, 1);
});

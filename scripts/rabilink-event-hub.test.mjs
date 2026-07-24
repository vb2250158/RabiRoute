import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { RabiLinkEventHub } from "./rabilink-event-hub.mjs";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.writableEnded = false;
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
  end() {
    this.writableEnded = true;
  }
  text() {
    return this.chunks.join("");
  }
}

test("RabiLink event hub targets the owning app and device without cross-app wakeups", () => {
  const hub = new RabiLinkEventHub({ keepAliveMs: 60000 });
  const first = new FakeResponse();
  const second = new FakeResponse();
  const otherApp = new FakeResponse();
  const one = hub.subscribe(first, { appId: "app-one", deviceId: "pc-one", deviceGuid: "guid-one" });
  const two = hub.subscribe(second, { appId: "app-one", deviceId: "pc-two", deviceGuid: "guid-two" });
  const three = hub.subscribe(otherApp, { appId: "app-two", deviceId: "pc-three", deviceGuid: "guid-three" });

  assert.equal(hub.hasSubscriber({ appId: "app-one", deviceGuid: "guid-one" }), true);
  assert.equal(hub.hasSubscriber({ appId: "app-two", deviceId: "pc-one" }), false);

  hub.publish("task_available", { appId: "app-one", targetDeviceId: "guid-one" });
  assert.match(first.text(), /event: task_available/);
  assert.doesNotMatch(second.text(), /event: task_available/);
  assert.doesNotMatch(otherApp.text(), /event: task_available/);

  hub.publish("outbox_available", { appId: "app-one" });
  assert.match(first.text(), /event: outbox_available/);
  assert.match(second.text(), /event: outbox_available/);
  assert.doesNotMatch(otherApp.text(), /event: outbox_available/);

  hub.publish("speech_available", { appId: "app-two", targetDeviceId: "pc-three" });
  assert.doesNotMatch(first.text(), /event: speech_available/);
  assert.doesNotMatch(second.text(), /event: speech_available/);
  assert.match(otherApp.text(), /event: speech_available/);

  one.close();
  assert.equal(hub.hasSubscriber({ appId: "app-one", deviceGuid: "guid-one" }), false);
  two.close();
  three.close();
  hub.close();
});

test("RabiLink event hub resolves one-shot waiters only for matching events", async () => {
  const hub = new RabiLinkEventHub({ keepAliveMs: 60000 });
  const matching = hub.waitFor("outbox_available", { appId: "app-one" }, 1000);
  const otherApp = hub.waitFor("outbox_available", { appId: "app-two" }, 20);

  hub.publish("outbox_available", { appId: "app-one" });

  assert.equal(await matching.promise, true);
  assert.equal(await otherApp.promise, false);
  hub.close();
});

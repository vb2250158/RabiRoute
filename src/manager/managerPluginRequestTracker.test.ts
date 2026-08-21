import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type http from "node:http";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";

function response(): http.ServerResponse {
  const emitter = new EventEmitter() as http.ServerResponse;
  return emitter;
}

const request = {} as http.IncomingMessage;
const url = new URL("http://localhost/test");

test("request tracker drains handled responses and rejects work after stop", async () => {
  const tracker = new ManagerPluginRequestTracker();
  const res = response();
  const wrapped = tracker.wrap(() => true);
  assert.equal(wrapped(request, url, res), true);
  assert.equal(tracker.activeCount(), 1);
  let stopped = false;
  const stopping = tracker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  res.emit("finish");
  await stopping;
  assert.equal(tracker.activeCount(), 0);
  assert.equal(wrapped(request, url, response()), false);
});

test("request tracker does not retain unrelated or throwing handlers", () => {
  const tracker = new ManagerPluginRequestTracker();
  assert.equal(tracker.wrap(() => false)(request, url, response()), false);
  assert.equal(tracker.activeCount(), 0);
  assert.throws(() => tracker.wrap(() => { throw new Error("failed"); })(request, url, response()), /failed/);
  assert.equal(tracker.activeCount(), 0);
});

test("request tracker settles once when close and finish both fire", async () => {
  const tracker = new ManagerPluginRequestTracker();
  const res = response();
  assert.equal(tracker.wrap(() => true)(request, url, res), true);
  res.emit("close");
  res.emit("finish");
  await tracker.stop();
  assert.equal(tracker.activeCount(), 0);
});

test("request tracker waits for actual operations after the HTTP response closes", async () => {
  const tracker = new ManagerPluginRequestTracker();
  let release!: () => void;
  const operation = new Promise<void>(resolve => { release = resolve; });
  tracker.trackOperation(operation);
  const res = response();
  assert.equal(tracker.wrap(() => true)(request, url, res), true);
  res.emit("close");

  let stopped = false;
  const stopping = tracker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(tracker.activeOperationCount(), 1);
  release();
  await stopping;
  assert.equal(tracker.activeOperationCount(), 0);
});


test("request tracker drains operations registered by an in-flight operation", async () => {
  const tracker = new ManagerPluginRequestTracker();
  let releaseChild!: () => void;
  const child = new Promise<void>(resolve => { releaseChild = resolve; });
  tracker.trackOperation(Promise.resolve().then(() => {
    tracker.trackOperation(child);
  }));

  let stopped = false;
  const stopping = tracker.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(tracker.activeOperationCount(), 1);
  releaseChild();
  await stopping;
  assert.equal(tracker.activeOperationCount(), 0);
});

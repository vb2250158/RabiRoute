import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readProgressEvent } from "./progress.mjs";
import { VideoService } from "./service.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
const workflow = { "13": { class_type: "SamplerCustomAdvanced" }, "14": { class_type: "VAEDecode" } };

test("node transitions clear the preceding percentage and zero is measurable", () => {
  const job = {};
  Object.assign(job, readProgressEvent(job, workflow, catalog.progressStages, "executing", { node: "13" }));
  assert.equal(job.progressStage, "采样");
  assert.equal(job.progressMax, null);
  Object.assign(job, readProgressEvent(job, workflow, catalog.progressStages, "progress", { node: "13", value: 0, max: 20 }));
  assert.equal(job.progress, 0); assert.equal(job.progressMax, 20);
  Object.assign(job, readProgressEvent(job, workflow, catalog.progressStages, "progress", { value: 20, max: 20 }));
  assert.equal(job.progress, 1);
  Object.assign(job, readProgressEvent(job, workflow, catalog.progressStages, "executing", { node: "14" }));
  assert.equal(job.progressStage, "解码画面");
  assert.equal(job.progressMax, null); assert.equal(job.progress, 0);
  for (const data of [{ node: "13", value: 2, max: 0 }, { node: "13", value: -1, max: 20 }, { node: "13", value: NaN, max: 20 }, { node: "missing", value: 1, max: 20 }]) {
    assert.equal(readProgressEvent(job, workflow, catalog.progressStages, "progress", data), null);
  }
});

test("WebSocket stages survive early events, reject foreign jobs, and appear in reconnect snapshots", async () => {
  let socket, complete = false, ready;
  const saved = new Promise(resolve => { ready = resolve; });
  class Socket extends EventTarget {
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(type, data) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, data }) })); }
    close() { this.dispatchEvent(new Event("close")); }
  }
  const events = [];
  const service = new VideoService({ alive: () => true }, catalog, (name, data) => events.push({ name, data }), { WebSocket: Socket });
  service.endpoint = "http://example.invalid";
  service.save = async () => ready();
  service.request = async route => {
    if (route === "/prompt") {
      socket.send("executing", { prompt_id: "mine", node: "13" });
      socket.send("progress", { prompt_id: "mine", node: "13", value: 0, max: 20 });
      return { prompt_id: "mine" };
    }
    return complete ? { mine: { status: { completed: true }, outputs: {} } } : {};
  };
  const job = { id: "test", model: catalog.models[0].id, status: "running", createdAt: new Date().toISOString() };
  service.jobs.set(job.id, job);
  const result = service.generate(job, workflow);
  await saved;
  assert.equal(job.progressMax, 20);
  socket.send("progress", { prompt_id: "other", node: "13", value: 19, max: 20 });
  assert.equal(job.progressValue, 0);
  socket.send("progress", { prompt_id: "mine", node: "13", value: 8, max: 20 });
  assert.equal(service.snapshot().jobs[0].progress, 0.4);
  assert.equal(events.at(-1).data.progressValue, 8);
  socket.send("executing", { prompt_id: "mine", node: "14" });
  assert.equal(service.snapshot().jobs[0].progressStage, "解码画面");
  assert.equal(events.at(-1).data.progressMax, null);
  complete = true;
  socket.send("execution_success", { prompt_id: "mine" });
  assert.deepEqual((await result).outputs, {});
});

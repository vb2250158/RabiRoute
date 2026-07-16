import assert from "node:assert/strict";
import test from "node:test";
import { resolveAndDeliverCodexSession } from "./codexSessionResolver.js";

test("an existing Rabi binding delivers directly to its exact Desktop task without creating", async () => {
  const existing = {
    id: "019f0000-0000-7000-8000-000000000031",
    title: "Rabi",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:00:00Z"
  };
  const delivered: unknown[] = [];

  const result = await resolveAndDeliverCodexSession({
    threadId: existing.id,
    title: existing.title,
    cwd: existing.cwd,
    prompt: "现有会话投递测试"
  }, {
    scope: {},
    read: async () => existing,
    list: async () => { throw new Error("must not list"); },
    create: async () => { throw new Error("must not create"); },
    deliver: async (params) => { delivered.push(params); }
  });

  assert.equal(result.kind, "id");
  assert.deepEqual(delivered, [{ thread: existing, prompt: "现有会话投递测试" }]);
});

test("a missing Rabi binding creates once and delivers every message to the new Desktop task", async () => {
  const created = {
    id: "019f0000-0000-7000-8000-000000000032",
    title: "新建 Rabi",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:00:00Z"
  };
  const scope = {};
  let createCount = 0;
  const delivered: Array<{ id: string; prompt: string }> = [];
  const dependencies = {
    scope,
    read: async () => null,
    // Simulate Desktop's read model lagging behind thread creation.
    list: async () => [],
    create: async () => {
      createCount += 1;
      return created;
    },
    deliver: async ({ thread, prompt }: { thread: typeof created; prompt: string }) => {
      delivered.push({ id: thread.id, prompt });
    }
  };

  const first = await resolveAndDeliverCodexSession({
    title: created.title,
    cwd: created.cwd,
    prompt: "第一条"
  }, dependencies);
  const second = await resolveAndDeliverCodexSession({
    title: created.title,
    cwd: created.cwd,
    prompt: "第二条"
  }, dependencies);

  assert.equal(createCount, 1);
  assert.equal(first.thread.id, created.id);
  assert.equal(second.thread.id, created.id);
  assert.deepEqual(delivered, [
    { id: created.id, prompt: "第一条" },
    { id: created.id, prompt: "第二条" }
  ]);
});

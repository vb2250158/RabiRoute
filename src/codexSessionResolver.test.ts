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

test("a Desktop rename invalidates the saved name-id pair and creates the configured name once", async () => {
  const stale = {
    id: "019f0000-0000-7000-8000-000000000033",
    title: "Desktop 已改名",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:00:00Z"
  };
  const created = {
    id: "019f0000-0000-7000-8000-000000000034",
    title: "Rabi 保存名",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:01:00Z"
  };
  let createCount = 0;
  const delivered: string[] = [];

  const result = await resolveAndDeliverCodexSession({
    threadId: stale.id,
    title: created.title,
    cwd: created.cwd,
    prompt: "改名后的第一条"
  }, {
    scope: {},
    read: async () => stale,
    list: async () => [],
    create: async () => { createCount += 1; return created; },
    deliver: async ({ thread }) => { delivered.push(thread.id); }
  });

  assert.equal(result.kind, "created");
  assert.equal(createCount, 1);
  assert.deepEqual(delivered, [created.id]);
});

test("changing the Rabi name rebinds by that name instead of delivering to the stale id", async () => {
  const stale = {
    id: "019f0000-0000-7000-8000-000000000035",
    title: "旧名字",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:00:00Z"
  };
  const renamedTarget = {
    id: "019f0000-0000-7000-8000-000000000036",
    title: "Rabi 新名字",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:01:00Z"
  };
  const delivered: string[] = [];

  const result = await resolveAndDeliverCodexSession({
    threadId: stale.id,
    title: renamedTarget.title,
    cwd: renamedTarget.cwd,
    prompt: "切换到新名字"
  }, {
    scope: {},
    read: async () => stale,
    list: async () => [renamedTarget],
    create: async () => { throw new Error("must not create when the new name already exists"); },
    deliver: async ({ thread }) => { delivered.push(thread.id); }
  });

  assert.equal(result.kind, "name");
  assert.deepEqual(delivered, [renamedTarget.id]);
});

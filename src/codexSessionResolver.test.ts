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

test("a saved id remains authoritative when Desktop title metadata changes after delivery", async () => {
  const existing = {
    id: "019f0000-0000-7000-8000-000000000033",
    title: "[RabiRoute 事件] 首条消息文本",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:00:00Z"
  };
  let createCount = 0;
  const delivered: string[] = [];

  const result = await resolveAndDeliverCodexSession({
    threadId: existing.id,
    title: "MonsterGirl / 伊莉娅 策划美术",
    cwd: existing.cwd,
    prompt: "标题元数据变化后的第二条"
  }, {
    scope: {},
    read: async () => existing,
    list: async () => { throw new Error("must not list when the saved id exists"); },
    create: async () => { createCount += 1; return existing; },
    deliver: async ({ thread }) => { delivered.push(thread.id); }
  });

  assert.equal(result.kind, "id");
  assert.equal(createCount, 0);
  assert.deepEqual(delivered, [existing.id]);
});

test("explicitly clearing the id before changing the Rabi name rebinds by the new name", async () => {
  const renamedTarget = {
    id: "019f0000-0000-7000-8000-000000000036",
    title: "Rabi 新名字",
    cwd: process.cwd(),
    updatedAt: "2026-07-16T00:01:00Z"
  };
  const delivered: string[] = [];

  const result = await resolveAndDeliverCodexSession({
    title: renamedTarget.title,
    cwd: renamedTarget.cwd,
    prompt: "切换到新名字"
  }, {
    scope: {},
    read: async () => { throw new Error("must not read without a saved id"); },
    list: async () => [renamedTarget],
    create: async () => { throw new Error("must not create when the new name already exists"); },
    deliver: async ({ thread }) => { delivered.push(thread.id); }
  });

  assert.equal(result.kind, "name");
  assert.deepEqual(delivered, [renamedTarget.id]);
});

test("an archived saved binding blocks delivery and never creates a replacement", async () => {
  const archived = {
    id: "019f0000-0000-7000-8000-000000000046",
    title: "MonsterGirl / 伊莉娅 策划美术",
    cwd: process.cwd(),
    updatedAt: "2026-07-18T04:00:00Z",
    archived: true
  };
  let createCount = 0;
  let deliverCount = 0;

  await assert.rejects(resolveAndDeliverCodexSession({
    threadId: archived.id,
    title: archived.title,
    cwd: archived.cwd,
    prompt: "不得创建替代任务"
  }, {
    scope: {},
    read: async () => archived,
    list: async () => [],
    create: async () => { createCount += 1; return archived; },
    deliver: async () => { deliverCount += 1; }
  }), /archived/);

  assert.equal(createCount, 0);
  assert.equal(deliverCount, 0);
});

test("multiple same-name Desktop tasks rebind to the most recently updated task without creating", async () => {
  const older = {
    id: "019f0000-0000-7000-8000-000000000037",
    title: "MonsterGirl / 伊莉娅 策划美术",
    cwd: process.cwd(),
    updatedAt: "2026-07-18T01:00:00Z"
  };
  const latest = {
    id: "019f0000-0000-7000-8000-000000000038",
    title: older.title,
    cwd: older.cwd,
    updatedAt: "2026-07-18T02:00:00Z"
  };
  let createCount = 0;
  const delivered: string[] = [];

  const result = await resolveAndDeliverCodexSession({
    title: older.title,
    cwd: older.cwd,
    prompt: "续投到最新同名任务"
  }, {
    scope: {},
    read: async () => null,
    // Deliberately return the older task first: resolver ordering is part of
    // the public behavior and must not depend on database row order.
    list: async () => [older, latest],
    create: async () => { createCount += 1; return older; },
    deliver: async ({ thread }) => { delivered.push(thread.id); }
  });

  assert.equal(result.kind, "name");
  assert.equal(result.thread.id, latest.id);
  assert.equal(createCount, 0);
  assert.deepEqual(delivered, [latest.id]);
});

test("same-name Desktop tasks with the same update time stay ambiguous without creating", async () => {
  const candidates = [
    {
      id: "019f0000-0000-7000-8000-000000000039",
      title: "同名同时间",
      cwd: process.cwd(),
      updatedAt: "2026-07-18T03:00:00Z"
    },
    {
      id: "019f0000-0000-7000-8000-000000000040",
      title: "同名同时间",
      cwd: process.cwd(),
      updatedAt: "2026-07-18T03:00:00Z"
    }
  ];
  let createCount = 0;
  let deliverCount = 0;

  await assert.rejects(resolveAndDeliverCodexSession({
    title: candidates[0].title,
    cwd: candidates[0].cwd,
    prompt: "不应随机投递"
  }, {
    scope: {},
    read: async () => null,
    list: async () => candidates,
    create: async () => { createCount += 1; return candidates[0]; },
    deliver: async () => { deliverCount += 1; }
  }), /ambiguous/);

  assert.equal(createCount, 0);
  assert.equal(deliverCount, 0);
});

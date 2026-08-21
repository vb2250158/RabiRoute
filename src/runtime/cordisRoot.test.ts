import assert from "node:assert/strict";
import test from "node:test";
import { createRabiCordisRoot, RabiCordisRoot } from "./cordisRoot.js";

test("Rabi Cordis root requires a name", () => {
  assert.throws(() => new RabiCordisRoot("  "), /Cordis root name is required/);
});

test("Rabi Cordis root initializes one runtime per key", async () => {
  const root = createRabiCordisRoot("Test");
  let initializeCount = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });

  const first = root.ensure("shared", async () => {
    initializeCount += 1;
    await gate;
    return { id: "runtime" };
  });
  const second = root.ensure("shared", async () => {
    initializeCount += 1;
    return { id: "duplicate" };
  });

  assert.strictEqual(first, second);
  finish();
  assert.deepEqual(await first, { id: "runtime" });
  assert.equal(initializeCount, 1);
  await root.dispose();
});

test("Rabi Cordis root removes failed initialization so the key can retry", async () => {
  const root = createRabiCordisRoot("Test");
  let attempts = 0;

  await assert.rejects(root.ensure("retry", async () => {
    attempts += 1;
    throw new Error("initialization failed");
  }), /initialization failed/);

  const value = await root.ensure("retry", async () => {
    attempts += 1;
    return "ready";
  });

  assert.equal(value, "ready");
  assert.equal(attempts, 2);
  await root.dispose();
});

test("Rabi Cordis root disposal waits for initialization before disposing the host", async () => {
  const root = createRabiCordisRoot("Test");
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let releases = 0;

  const initializing = root.ensure("pending", async (host) => {
    await gate;
    await host.mount({
      name: "test:pending-initialization",
      apply(ctx) {
        ctx.effect(() => () => { releases += 1; });
      }
    });
    return "ready";
  });

  const disposing = root.dispose();
  let disposeFinished = false;
  void disposing.then(() => { disposeFinished = true; });
  await Promise.resolve();

  assert.equal(disposeFinished, false);
  assert.equal(root.disposed, false);
  await assert.rejects(
    root.ensure("late", async () => "late"),
    /Test Cordis root is disposing/
  );

  finish();
  assert.equal(await initializing, "ready");
  await disposing;

  assert.equal(disposeFinished, true);
  assert.equal(root.disposed, true);
  assert.equal(releases, 1);
});

test("Rabi Cordis root disposal is idempotent", async () => {
  const root = createRabiCordisRoot("Test");
  let releases = 0;
  await root.host.mount({
    name: "test:root-dispose",
    apply(ctx) {
      ctx.effect(() => () => { releases += 1; });
    }
  });

  const first = root.dispose();
  const second = root.dispose();
  assert.strictEqual(first, second);
  await first;
  await root.dispose();

  assert.equal(root.disposed, true);
  assert.equal(releases, 1);
  await assert.rejects(
    root.ensure("late", async () => "late"),
    /Test Cordis root is disposed/
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { EffectScope } from "./effectScope.js";

test("EffectScope aborts before reverse-order disposal and includes adopted resources", async () => {
  const scope = new EffectScope();
  const lifecycle: string[] = [];
  scope.adopt(() => { lifecycle.push(`adopted:${scope.signal().aborted}`); });
  scope.add(() => {
    lifecycle.push("start:first");
    return () => { lifecycle.push(`stop:first:${scope.signal().aborted}`); };
  });
  scope.add(() => {
    lifecycle.push("start:second");
    return () => { lifecycle.push(`stop:second:${scope.signal().aborted}`); };
  });
  await scope.commit();
  await scope.dispose();
  assert.deepEqual(lifecycle, [
    "start:first", "start:second", "stop:second:true", "stop:first:true", "adopted:true"
  ]);
});

test("EffectScope releases adopted resources when commit fails", async () => {
  const scope = new EffectScope();
  let released = false;
  scope.adopt(() => { released = true; });
  scope.add(() => { throw new Error("commit failed"); });
  await assert.rejects(scope.commit(), /commit failed/);
  assert.equal(released, true);
});

test("EffectScope bounds a non-settling disposer and continues releasing later resources", async () => {
  const scope = new EffectScope({ disposalTimeoutMs: 20 });
  let laterReleased = false;
  scope.adopt(() => { laterReleased = true; }, "later resource");
  scope.adopt(async () => { await new Promise(() => {}); }, "hung resource");

  await assert.rejects(scope.dispose(), /hung resource.*20ms/);
  assert.equal(laterReleased, true);
});

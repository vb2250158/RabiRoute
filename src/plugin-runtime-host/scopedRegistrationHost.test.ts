import assert from "node:assert/strict";
import test from "node:test";
import { EffectScope } from "../plugin-kernel/effectScope.js";
import type { PluginContext } from "../plugin-kernel/types.js";
import { createScopedAsyncRegistrationService } from "./scopedRegistrationHost.js";
import { scopedAsyncPluginService } from "./asyncServiceTransport.js";

function setup(register: (context: PluginContext) => Promise<{ dispose(): Promise<void> }>) {
  const effects = new EffectScope();
  const context = { identity: { activationId: "fixture-activation" }, effects, lifecycle: { signal: effects.signal() } } as unknown as PluginContext;
  const token = createScopedAsyncRegistrationService({ label: "fixture registration", register });
  return { effects, context, api: scopedAsyncPluginService(token)!.createScope(context) as { prepareRegistration(): Promise<{ registrationId: string }> } };
}

test("prepare returns one cloneable handle and native registration starts only in original SDK commit", async () => {
  let registrations = 0, disposals = 0;
  const f = setup(async () => { registrations++; return { async dispose() { disposals++; } }; });
  const first = await f.api.prepareRegistration();
  assert.equal(await f.api.prepareRegistration(), first);
  assert.deepEqual(structuredClone(first), first);
  assert.equal(registrations, 0);
  await f.effects.commit();
  assert.equal(registrations, 1);
  await f.effects.dispose();
  await f.effects.waitForRetirement();
  assert.equal(disposals, 1);
});

test("abort before commit starts no native operation and revokes the prepared handle", async () => {
  let registrations = 0;
  const f = setup(async () => { registrations++; return { async dispose() {} }; });
  await f.api.prepareRegistration();
  await f.effects.dispose();
  await assert.rejects(f.api.prepareRegistration(), { code: "REGISTRATION_SCOPE_REVOKED" });
  assert.equal(registrations, 0);
});

test("late native registration stays with original retirement and is disposed exactly once", async () => {
  let release!: () => void, entered!: () => void, disposed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = setup(async () => { entered(); await gate; return { async dispose() { disposed++; } }; });
  await f.api.prepareRegistration();
  const commit = f.effects.commit();
  const rejected = assert.rejects(commit);
  await started;
  let retired = false;
  const disposal = f.effects.dispose().then(() => undefined, error => {
    assert.match((error as Error).message, /lifecycle operations are still running/);
  });
  const joined = f.effects.waitForRetirement().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(retired, false);
  release();
  await rejected;
  await disposal;
  await joined;
  assert.equal(retired, true);
  assert.equal(disposed, 1);
});

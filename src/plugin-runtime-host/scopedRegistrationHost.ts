import { randomUUID } from "node:crypto";
import type { PluginContext } from "../plugin-kernel/types.js";
import { declareScopedAsyncPluginService } from "./asyncServiceTransport.js";

type OwnedRegistration = Readonly<{ dispose(): void | Promise<void> }>;
type RegistrationHandle = Readonly<{ registrationId: string; activationId: string }>;

/** Prepare a parent's real SDK effect, never serialize native owners or callbacks. */
export function createScopedAsyncRegistrationService(options: Readonly<{
  label: string;
  register(context: PluginContext): Promise<OwnedRegistration>;
}>): object {
  return declareScopedAsyncPluginService(["prepareRegistration"], { prepareRegistration: "owned-resource" }, context => {
    let accepting = !context.lifecycle.signal.aborted;
    let prepared: RegistrationHandle | undefined;
    let started = false, registration: Promise<OwnedRegistration> | undefined, cleanup: Promise<void> | undefined;
    const revoked = () => Object.assign(new Error("Original registration scope is closed."), { code: "REGISTRATION_SCOPE_REVOKED" });
    const close = (): Promise<void> => {
      accepting = false;
      return cleanup ??= Promise.resolve().then(async () => {
        if (!started) return;
        // The original Promise is assigned before invoking register(), including
        // synchronous reentrant abort. Do not substitute an independent retry.
        const original = await registration!;
        await original.dispose();
      }).finally(() => context.lifecycle.signal.removeEventListener("abort", onAbort));
    };
    const onAbort = () => { void close().catch(() => {}); };
    // Installed synchronously before child launch. Failed/late native work stays
    // with this same SDK owner, even if the child never receives its handle.
    context.effects.adopt(close, options.label + ": join original parent registration");
    context.lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    return {
      async prepareRegistration(): Promise<RegistrationHandle> {
        if (!accepting || context.lifecycle.signal.aborted) throw revoked();
        if (prepared) return prepared;
        const handle = Object.freeze({ registrationId: randomUUID(), activationId: context.identity.activationId });
        context.effects.add(async () => {
          if (!accepting || context.lifecycle.signal.aborted) throw revoked();
          started = true;
          let resolve!: (value: OwnedRegistration | PromiseLike<OwnedRegistration>) => void, reject!: (reason: unknown) => void;
          registration = new Promise<OwnedRegistration>((done, failed) => { resolve = done; reject = failed; });
          try { resolve(options.register(context)); } catch (error) { reject(error); }
          await registration;
          if (!accepting || context.lifecycle.signal.aborted) { await close(); throw revoked(); }
          return close;
        }, options.label + ": start prepared parent registration");
        prepared = handle;
        return handle;
      }
    };
  });
}

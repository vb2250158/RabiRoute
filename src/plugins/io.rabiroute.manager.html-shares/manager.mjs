import { definePlugin } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";

export const activate = definePlugin({
  async activate(context) {
    const shared = context.services.require("host.manager.rabilink-relay@2");
    const operations = context.services.require("host.manager.operations@1");
    const transports = context.services.require("host.peer-transports@1");
    const relay = context.services.require("manager.rabilink-relay@1");
    await shared.prepareModules(hostModules);
    const owner = createImplementation(shared).createOwnedRuntime(shared, transports, context.identity, relay.connection);
    context.effects.adopt(() => owner.stop(), "prepared HTML snapshot owner");
    context.services.provide("manager.html-shares@1", Object.freeze({
      publish: (file, deliveryId) => owner.publish(file, deliveryId),
      upgrade: (request, socket, head) => owner.upgrade(request, socket, head)
    }));
    context.effects.add(async () => {
      let http, upgrade;
      let stopping;
      const stop = () => stopping ??= (async () => {
        upgrade?.stopAccepting();
        // Revoked registration and the original owner stop together, including accepted reads/handshakes.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => http?.dispose()),
          Promise.resolve().then(() => upgrade?.dispose()),
          Promise.resolve().then(() => owner.stop())
        ]);
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      })();
      context.effects.adopt(stop, "HTML operation and upgrade retirement");
      try {
        context.lifecycle.signal.throwIfAborted();
        http = await operations.registerOperationsAsync(owner.operations(), context.lifecycle.signal);
        context.lifecycle.signal.throwIfAborted();
        upgrade = operations.registerUpgrades(owner.upgrades());
        context.lifecycle.signal.throwIfAborted();
        return stop;
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      }
    }, "activate independent HTML shares");
  }
}).activate;

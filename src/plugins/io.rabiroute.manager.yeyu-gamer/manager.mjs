import { createImplementation, hostModules } from "./manager-runtime.mjs";
import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  async activate(context) {
    const shared = context.services.require("host.manager.yeyu-gamer@2");
        await shared.prepareModules(hostModules);
        const runtime = createImplementation(shared).createOwnedRuntime(shared);
    context.services.provide("manager.yeyu-gamer@1", Object.freeze({
      instanceId: context.identity.instanceId
    }));

    context.effects.add(async () => {
      const owner = runtime.createYeYuGamerManagerOperations({ getConfig: () => context.config });
      let stopping;
      const stopOwner = () => stopping ??= Promise.resolve().then(() => owner.stop());
      context.effects.adopt(stopOwner, "prepared game automation owner");
      let registration;
      try { registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, owner.operations, context.lifecycle.signal); }
      catch (error) { await stopOwner(); throw error; }
      return async () => {
        const retired = registration.dispose();
        await stopOwner();
        await retired;
      };
    }, "YeYu Gamer Manager routes");
  }
}).activate;

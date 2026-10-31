import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
  activate(context) {
    const runtime = context.services.require("host.manager.desktop-pet@1");
    context.services.provide("manager.desktop-pet@1", Object.freeze({ instanceId: context.identity.instanceId }));
    context.effects.add(async () => {
      const owner = new runtime.DesktopPetOwner({ resolveRoleDir: runtime.resolveRoleDir, settings: runtime.desktopSettings, publishEvent: runtime.publishManagerEvent });
      let stopping;
      const stopOwner = () => stopping ??= Promise.resolve().then(() => owner.stop());
      context.effects.adopt(stopOwner, "prepared Desktop pet owner");
      let registration;
      try { registration = await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, runtime.createDesktopPetOperations(owner), context.lifecycle.signal); }
      catch (error) { await stopOwner(); throw error; }
      return async () => {
        const retired = registration.dispose(); // Synchronously stop admission before awaiting accepted owners.
        try { await retired; } finally { await stopOwner(); }
      };
    }, "Desktop pet Manager operations");
  }
}).activate;

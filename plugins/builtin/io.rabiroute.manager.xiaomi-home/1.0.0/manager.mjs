import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const runtime = context.services.require("host.manager.xiaomi-home@1");
    context.services.provide("manager.xiaomi-home@1", Object.freeze({ instanceId: context.identity.instanceId }));
    context.contributions.register({
      kind: "message-endpoint-settings",
      id: "xiaomi-home-message-endpoint",
      value: {
        surface: "route.adapters",
        label: { fallback: "米家 / Xiaomi Home" },
        rendererId: "builtin.xiaomi-home-message-endpoint.v1",
        schemaId: "xiaomi-home.settings.v1",
        readCommandId: "manager.xiaomi-home-settings.read",
        writeCommandId: "manager.xiaomi-home-settings.write",
        icon: "mdi-home-automation",
        slot: "xiaomiHome",
        hosts: ["web"],
        order: 50
      }
    });
    context.contributions.register({
      kind: "message-endpoint-settings",
      id: "xiaomi-home-message-endpoint-auth",
      value: {
        surface: "route.adapters",
        label: { fallback: "米家 / Xiaomi Home 连接" },
        rendererId: "builtin.xiaomi-home-auth.v1",
        schemaId: "xiaomi-home.auth.v1",
        readCommandId: "manager.xiaomi-home-auth.read",
        writeCommandId: "manager.xiaomi-home-auth.write",
        icon: "mdi-shield-key-outline",
        slot: "xiaomiHome",
        hosts: ["web"],
        order: 51
      }
    });
    let xiaomiHomeRuntime;
    let publishedOwner;
    let previousOwner;
    let ready = false;
    let disposal;
    const registrations = [];
    // This activation owns these exact objects. Cleanup is shared by failed
    // preparation and published retirement and never stops a replacement owner.
    const dispose = () => disposal ??= (async () => {
      ready = false;
      const settled = await Promise.allSettled([
        ...registrations.map(registration => Promise.resolve().then(() => registration.dispose())),
        Promise.resolve().then(() => xiaomiHomeRuntime?.stop())
      ]);
      if (publishedOwner === xiaomiHomeRuntime) publishedOwner = undefined;
      const failures = settled.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Xiaomi Home retirement was not confirmed.");
    })();
    context.effects.adopt(dispose, "release Xiaomi Home candidate resources");
    context.publication.add({
      publish() {
        previousOwner = publishedOwner;
        publishedOwner = xiaomiHomeRuntime;
      },
      rollback() {
        if (publishedOwner === xiaomiHomeRuntime) publishedOwner = previousOwner;
        ready = false;
      },
      async afterPublish({ previousRetirement, signal }) {
        await previousRetirement;
        signal.throwIfAborted();
        await xiaomiHomeRuntime.activate(signal);
        signal.throwIfAborted();
        ready = true;
      },
      retire: dispose
    }, "publish Xiaomi Home native owner");
    context.effects.add(async () => {
      let activationStage = "read-only artifact snapshot";
      try {
        const artifacts = new runtime.XiaomiHomeArtifactStore(context.config.runtimeDir);
        activationStage = "settings store";
        const settingsStore = new runtime.XiaomiHomeSettingsStore(artifacts.runtimeDir, context.config);
        activationStage = "runtime controller";
        xiaomiHomeRuntime = new runtime.XiaomiHomeRuntimeController(settingsStore, artifacts, {
          readOnly: runtime.managerReadOnly === true,
          roleDirectory: runtime.roleDirectory,
          deliverEvent: runtime.deliverXiaomiHomeEvent,
          activity: runtime.homeAssistantActivity
        });
        activationStage = "executable contracts";
        const definitions = runtime.createXiaomiHomeManagerOperations({
          runtime: xiaomiHomeRuntime,
          assertRuntimeAvailable() {
            xiaomiHomeRuntime.assertAvailable(publishedOwner === xiaomiHomeRuntime && ready && !context.lifecycle.signal.aborted);
          },
          lifecycleFence: runtime.lifecycleFence,
          controlPlaneAccessAllowed: runtime.webguiLanRequestAllowed,
          deliverEvent: runtime.deliverXiaomiHomeEvent
        });
        activationStage = "route registration";
        registrations.push(await runtime.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId, definitions.operations, context.lifecycle.signal));
        registrations.push(runtime.managerPluginRoutes.registerHttpProxies(context.identity.instanceId, definitions.proxies));
        return dispose;
      } catch (error) {
        await dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Xiaomi Home activation failed during ${activationStage}: ${message}`, { cause: error });
      }
    }, "Xiaomi Home Manager routes");
    context.contributions.register({
      kind: "message-endpoint-settings", id: "xiaomi-home-devices",
      value: { surface: "route.adapters", label: { fallback: "设备列表" },
        rendererId: "builtin.xiaomi-home-devices.v1", schemaId: "xiaomi-home.settings.v1",
        readCommandId: "manager.xiaomi-home-settings.read", writeCommandId: "manager.xiaomi-home-settings.write",
        icon: "mdi-devices", slot: "xiaomiHome", hosts: ["web"], order: 52 }
    });
  }
}).activate;

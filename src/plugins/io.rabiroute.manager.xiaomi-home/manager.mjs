import { definePlugin, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";
import { fileURLToPath } from "node:url";

export const activate = definePlugin({
  async activate(context) {
    const host = context.services.require("host.message-endpoints@1");
    await host.prepareModules(hostModules);
    const implementation = createImplementation(host);
    implementation.configureXiaomiHomePluginResources({
      homeAssistantInstallScript: fileURLToPath(new URL("./resources/Install-HomeAssistantOs.ps1", import.meta.url)),
      vacuumVideoWorker: fileURLToPath(new URL("./workers/vacuumVideoWorker.mjs", import.meta.url))
    });
    const manager = host.manager;
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
    context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-xiaomiHome-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "米家 / Xiaomi Home"
    },
    "endpointType": "xiaomiHome",
    "catalog": {
      "title": "米家 / Xiaomi Home",
      "note": "连接家庭设备、状态与事件",
      "icon": "mdi-home-automation",
      "group": {
        "id": "devices",
        "title": "设备与自定义接入",
        "note": "连接手机、设备及自定义系统",
        "order": 20
      },
      "order": 10
    },
    "rendererId": "endpoint.xiaomiHome.card.v1",
    "schemaId": "endpoint.xiaomiHome.route.v1",
    "readCommandId": "endpoint.xiaomiHome.route.read",
    "writeCommandId": "endpoint.xiaomiHome.route.write",
    "icon": "mdi-home-automation",
    "slot": "xiaomiHome",
    "hosts": [
      "web"
    ],
    "order": 10
  }
});
    let xiaomiHomeRuntime;
    let eventDelivery;
    ownMessageEndpointScan(context, { type: "xiaomiHome", label: "米家 / Xiaomi Home", maturity: "experimental", async scan() { const health = await xiaomiHomeRuntime.health(); return {type:"xiaomiHome",label:"米家 / Xiaomi Home",maturity:"experimental",installed:true,requirements:[{id:"authorization",label:"Home Assistant 授权",required:true,ok:health.status==="ready"&&health.tokenConfigured===true}],warnings:[]}; } });

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
        Promise.resolve().then(() => xiaomiHomeRuntime?.stop()),
        Promise.resolve().then(() => eventDelivery?.stop())
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
        const artifacts = new implementation.XiaomiHomeArtifactStore(context.config.runtimeDir);
        activationStage = "settings store";
        const settingsStore = new implementation.XiaomiHomeSettingsStore(artifacts.runtimeDir, context.config);
        eventDelivery = implementation.createXiaomiHomeGatewayDelivery(host.gatewayExecution, manager.roleDirectory);
        activationStage = "runtime controller";
        xiaomiHomeRuntime = new implementation.XiaomiHomeRuntimeController(settingsStore, artifacts, {
          readOnly: manager.readOnly === true,
          roleDirectory: manager.roleDirectory,
          deliverEvent: eventDelivery.deliverEvent,
          activity: manager.activity
        });
        activationStage = "executable contracts";
        const definitions = implementation.createXiaomiHomeManagerOperations({
          runtime: xiaomiHomeRuntime,
          assertRuntimeAvailable() {
            xiaomiHomeRuntime.assertAvailable(publishedOwner === xiaomiHomeRuntime && ready && !context.lifecycle.signal.aborted);
          },
          lifecycleFence: manager.lifecycleFence,
          controlPlaneAccessAllowed: manager.access,
          deliverEvent: eventDelivery.deliverEvent
        });
        activationStage = "route registration";
        registrations.push(await manager.routes.registerOperationsAsync(context.identity.instanceId, definitions.operations, context.lifecycle.signal));
        registrations.push(manager.routes.registerHttpProxies(context.identity.instanceId, definitions.proxies));
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

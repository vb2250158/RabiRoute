import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpoint } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./runtime.mjs";
import { projectRouteTransport } from "./route-config.mjs";
export const activate = definePlugin({ async activate(context) {
  const runtime = context.services.require("host.message-endpoints@4");
  await runtime.prepareModules(hostModules);
  const transport = projectRouteTransport(context.config, runtime.module("config").config);
  const host = runtime.forActivation(transport ? { ...context.config, __routeTransport: transport, __routeInheritedFields: [] } : context.config);
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "napcat", operations: {
    readReplySource: egress.readReplySource,
    getLoginInfo: egress.getLoginInfo,
    sendGroupMessage: egress.sendGroupMessage,
    sendPrivateMessage: egress.sendPrivateMessage,
    uploadGroupFile: egress.uploadGroupFile,
    uploadPrivateFile: egress.uploadPrivateFile,
    readNapCatGroupFiles: egress.readNapCatGroupFiles,
    napcatStickerMessage: egress.napcatStickerMessage
  } });
  await host.prepareModules(hostModules);
  const routeId = context.identity.managerInstanceId;
  const configuredBotUserId = id => context.config.__routeTransportInputs?.napcatInstances?.find(instance => instance.id === id)?.botUserId;
  const endpoint = createImplementation(host).create({
    routeId,
    eventBotUserId: configuredBotUserId,
    captureQuickRequestContext: (event, instance, frame, authorize) => egress.captureNapcatQuickRequestContext(
      host.protectedResourceObjects,
      {routeId, instanceId: instance.id,
        botUserId: String(configuredBotUserId(instance.id) ?? ""),
        httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? ""},
      event, authorize, frame.signal)
  });
  context.services.provide("endpoint.napcat@1", Object.freeze({ type: "napcat" }));
  ownMessageEndpoint(context, endpoint);
} }).activate;

import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan, ownPluginAcceptedWork } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  const speech = context.services.require("manager.speech@1");
  ownMessageEndpointEgress(context, { type: "speech", operations: { requestLocalSpeech: (...args) => speech.runAcceptedWork(() => egress.requestLocalSpeech(...args)) } });
  const work = ownPluginAcceptedWork(context, "accepted speech deliveries");
  ownMessageEndpointScan(context, { type: "speech", label: "语音消息端", maturity: "verified", async scan() {
    const status = await speech.speechControl.status();
    return { type: "speech", label: "语音消息端", maturity: "verified", installed: status.state === "online",
      endpoints: [{ label: "RabiSpeech", url: status.configuredUrl, healthy: status.state === "online" }],
      requirements: [], warnings: status.error ? [status.error] : [] };
  } });
  // The published capability is the native Route subscription. The shared
  // speech service consults it when admitting transcripts to speech Routes.
  context.services.provide("endpoint.speech@1", Object.freeze({ type: "speech", instanceId: context.identity.instanceId,
    runAcceptedWork(operation) {
      return work.runAcceptedWork(() => speech.runAcceptedWork(operation));
    }
  }));
  context.contributions.register({ kind: "message-endpoint-settings", id: "endpoint-speech-card", value: {
    surface: "route.adapters", label: { fallback: "语音消息端" }, endpointType: "speech",
    catalog: { title: "语音消息端", note: "使用麦克风与语音播放交流", icon: "mdi-microphone",
      group: { id: "local", title: "本机与任务", note: "连接本地输入和主动任务", order: 30 }, order: 10 },
    rendererId: "endpoint.speech.card.v1", schemaId: "endpoint.speech.route.v1",
    readCommandId: "endpoint.speech.route.read", writeCommandId: "endpoint.speech.route.write",
    icon: "mdi-microphone", slot: "speech", hosts: ["web"], order: 10
  } });
} }).activate;

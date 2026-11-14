import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
  async activate(context) {
    context.services.require("manager.speech@1");
    context.services.provide("manager.voice-assistant@1", Object.freeze({ instanceId: context.identity.instanceId }));
    context.contributions.register({ kind: "page", id: "voice-assistant-page", value: {
      surface: "web.pages", label: { fallback: "语音助手" }, routeId: "global.voice-assistant",
      rendererId: "builtin.web-page.voice-assistant.v1", slot: "route", hosts: ["web"], order: 51
    } });
    context.contributions.register({ kind: "navigation", id: "voice-assistant", value: {
      surface: "web.navigation", label: { fallback: "语音助手" }, routeId: "global.voice-assistant",
      icon: "mdi-microphone-message", slot: "utility", hosts: ["web"], order: 51
    } });
  }
}).activate;

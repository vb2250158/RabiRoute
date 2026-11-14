import type { TrustedWebPageRegistration } from "../../../../ribiwebgui/src/pluginPages";
type Api = { instanceIds: readonly string[]; forInstance(id: string): {
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
} };
export function activate(api: Api): () => void {
  const disposers = api.instanceIds.map(id => api.forInstance(id).registerPage({
    routeId: "global.voice-assistant", rendererId: "builtin.web-page.voice-assistant.v1",
    loader: () => import("./VoiceAssistantPage.vue"),
    paths: [{ path: "/voice-assistant", title: "语音助手" }],
    navigation: { resolvePath: () => "/voice-assistant", allowedSlots: ["utility"], allowedIcons: ["mdi-microphone-message"] }
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

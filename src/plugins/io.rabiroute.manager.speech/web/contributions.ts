import { type WebContributionApi, registerContributionPages } from "../../../../ribiwebgui/src/pluginWebContributionApi";
import { routeScopedSpeechPath } from "../../../../ribiwebgui/src/routeScopedNavigation";

export function activateSpeech(api: WebContributionApi): readonly (() => void)[] {
  return [
    ...registerContributionPages(api, [{
      routeId: "route.speech", rendererId: "builtin.web-page.speech.v1",
      loader: () => import("./pages/SpeechServicePage.vue"),
      paths: [{ path: "/speech", title: "语音服务" }, { path: "/routes/:id/speech", title: "语音服务" }],
      navigation: { resolvePath: routeScopedSpeechPath, allowedSlots: ["utility"], allowedIcons: ["mdi-waveform"] }
    }]),
    api.registerStatusRenderer({ rendererId: "builtin.speech-status.v1", placementId: "runtime-status", allowedSlots: ["runtime-status"], queryId: "manager.speech-status", loader: () => import("./components/renderers/SpeechStatusRenderer.vue") })
  ];
}

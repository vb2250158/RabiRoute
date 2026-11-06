import { type WebContributionApi } from "../../../../ribiwebgui/src/pluginWebContributionApi";

export function activateDesktop(api: WebContributionApi): readonly (() => void)[] {
  return [api.registerSettingsRenderer({
    rendererId: "builtin.desktop-settings.v1", placementId: "global.settings.sections", allowedSlots: ["desktop"],
    contributionKind: "settings-section", contributionSurface: "shared.settings",
    schemaId: "desktop.settings.v1", readCommandId: "manager.desktop-settings.read", writeCommandId: "manager.desktop-settings.write",
    loader: () => import("./components/renderers/DesktopSettingsRenderer.vue")
  })];
}

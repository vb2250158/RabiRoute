import { type WebContributionApi } from "../../../../ribiwebgui/src/pluginWebContributionApi";

export function activateXiaomiHome(api: WebContributionApi): readonly (() => void)[] {
  return [
    api.registerSettingsRenderer({
      rendererId: "builtin.xiaomi-home-message-endpoint.v1", placementId: "route.adapters.message-endpoint-settings", allowedSlots: ["xiaomiHome"],
      contributionKind: "message-endpoint-settings", contributionSurface: "route.adapters",
      schemaId: "xiaomi-home.settings.v1", readCommandId: "manager.xiaomi-home-settings.read", writeCommandId: "manager.xiaomi-home-settings.write",
      loader: () => import("./components/renderers/XiaomiHomeSettingsRenderer.vue")
    }),
    api.registerSettingsRenderer({
      rendererId: "builtin.xiaomi-home-auth.v1", placementId: "route.adapters.message-endpoint-settings", allowedSlots: ["xiaomiHome"],
      contributionKind: "message-endpoint-settings", contributionSurface: "route.adapters",
      schemaId: "xiaomi-home.auth.v1", readCommandId: "manager.xiaomi-home-auth.read", writeCommandId: "manager.xiaomi-home-auth.write",
      loader: () => import("./components/renderers/XiaomiHomeMessageEndpointRenderer.vue")
    }),
    api.registerSettingsRenderer({
      rendererId: "builtin.xiaomi-home-devices.v1", placementId: "route.adapters.message-endpoint-settings", allowedSlots: ["xiaomiHome"],
      contributionKind: "message-endpoint-settings", contributionSurface: "route.adapters",
      schemaId: "xiaomi-home.settings.v1", readCommandId: "manager.xiaomi-home-settings.read", writeCommandId: "manager.xiaomi-home-settings.write",
      loader: () => import("./components/renderers/XiaomiHomeDevicesRenderer.vue")
    })
  ];
}

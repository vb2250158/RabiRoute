import { type WebCommandContributionApi } from "../../../../ribiwebgui/src/pluginWebContributionApi";

export function activateRouteControl(api: WebCommandContributionApi): readonly (() => void)[] {
  return [
    api.registerCommand({ handlerId: "web.create-role", allowedSlots: ["sidebar-footer-primary"],
      allowedIcons: ["mdi-account-plus-outline"], appearance: "primary", execute: context => context.createRole() }),
    api.registerCommand({ handlerId: "web.add-route", allowedSlots: ["topbar-primary"],
      allowedIcons: ["mdi-plus"], execute: context => context.addRoute() }),
    api.registerCommand({ handlerId: "web.open-manager-config", allowedSlots: ["sidebar-footer"],
      allowedIcons: ["mdi-folder-cog-outline"], execute: context => context.openManagerConfig() })
  ];
}

import type { GatewayDefinition, MessageAdapterType, RuntimeStatus } from "../../../../ribiwebgui/src/types";
import { isAdapterDisabled } from "../../../../ribiwebgui/src/utils/gatewayHelpers";

export type EndpointConnection = "setup" | "disconnected" | "connected" | "issue";

function liveConnection(connected: boolean | undefined, knownAccount: boolean): EndpointConnection {
  if (connected === true) return "connected";
  return connected === false && knownAccount ? "issue" : "disconnected";
}

export function messageEndpointConnection(route: GatewayDefinition | undefined, runtime: RuntimeStatus, type: MessageAdapterType): EndpointConnection {
  if (type !== "napcat" && type !== "qqbot" && type !== "weixin" && type !== "wecom" && type !== "feishu") return "setup";
  if (!route || isAdapterDisabled(route, type)) return "disconnected";
  if (runtime.id !== route.id || route.enabled === false) return "disconnected";
  const status = runtime.gatewayStatus;
  const adapter = status?.messageAdapters?.[type] ?? status?.[type];
  if (type === "napcat") {
    const configured = route.napcatInstances?.find(instance => instance.enabled !== false);
    const current = (status?.napcatInstances as Array<{ routeId?: string; id: string; botUserId?: string; connected?: boolean; online?: boolean }> | undefined)
      ?.find(instance => instance.routeId === route.id && instance.id === configured?.id);
    const expected = configured?.botUserId;
    if (current?.connected === true && expected && current.botUserId && String(current.botUserId) !== String(expected)) return "issue";
    return liveConnection(runtime.running === false || current?.online === false ? false : current?.connected, Boolean(expected));
  }
  if (type === "weixin") {
    if (adapter?.sessionPhase === "invalid" || adapter?.sessionPhase === "temporarily_unreachable") return "issue";
    return liveConnection(runtime.running === false ? false : adapter?.loggedIn, adapter?.credentialsRetained === true);
  }
  if (type === "qqbot") {
    if (!route.qqbotAccountId) return "disconnected";
    if (runtime.running === false || adapter?.status === "error") return "issue";
    return liveConnection(adapter?.accountId === route.qqbotAccountId ? adapter.connected : undefined, true);
  }
  const authorized = type === "wecom" ? Boolean(route.wecomBotId) : Boolean(route.feishuAppId);
  const connected = runtime.running === false || adapter?.status === "error" || adapter?.connected === false ? false : adapter?.authenticated;
  return liveConnection(connected, authorized);
}

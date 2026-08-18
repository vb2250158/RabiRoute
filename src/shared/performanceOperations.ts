export const PERFORMANCE_OPERATIONS = {
  managerMetaBuild: "manager.meta.build",
  managerGatewaysBuildSummary: "manager.gateways.build_summary",
  managerGatewaysBuildDiagnostics: "manager.gateways.build_diagnostics",
  managerHttpJsonSerialize: "manager.http.json_serialize",
  managerPlanCatalogCacheHit: "manager.plan_catalog.cache_hit",
  managerPlanCatalogColdLoad: "manager.plan_catalog.cold_load",
  managerPlanCatalogRefresh: "manager.plan_catalog.refresh",
  managerMessageBoardPersist: "manager.message_board.persist",
  managerMessageBoardSummary: "manager.message_board.summary",
  managerAgentScanDesktopReady: "manager.agent_scan.desktop_ready",
  managerAgentScanCodexCatalog: "manager.agent_scan.codex_catalog",
  managerSpeechStatusCacheHit: "manager.speech.status.cache_hit",
  managerSpeechStatusSharedFlight: "manager.speech.status.shared_flight",
  performanceStoreSummary: "manager.performance_store.summary",
  runtimeHistoryAppend: "runtime.history.append",
  runtimeHistoryDuplicateScan: "runtime.history.duplicate_scan",
  gatewayForwardTotal: "gateway.forward.total",
  gatewayRouteDecision: "gateway.forward.route_decision",
  gatewayPacketBuild: "gateway.forward.packet_build",
  gatewayAgentDeliver: "gateway.forward.agent_deliver",
  gatewayMessageRegister: "gateway.forward.message_register"
} as const;

export function managerReadWorkerOperation(stage: "queue_wait" | "execute", taskType: string): string {
  return `manager.read_worker.${stage}.${taskType}`;
}

export function managerSpeechProbeOperation(endpoint: "health" | "capabilities"): string {
  return `manager.speech.probe.${endpoint}`;
}

export function webguiRouteRenderOperation(pathname: string): string {
  const normalized = pathname
    .replace(/\/routes\/[^/]+/g, "/routes/:routeId")
    .replace(/\/persona\/[^/]+/g, "/persona/:roleId")
    .replace(/[^a-zA-Z0-9/:_-]+/g, "_")
    .replace(/\//g, ".")
    .replace(/:+/g, "_")
    .replace(/^\.+|\.+$/g, "");
  return `webgui.route_render.${normalized || "root"}`.slice(0, 120);
}

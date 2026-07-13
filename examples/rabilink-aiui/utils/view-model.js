export function selectedItem(list, index) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.max(0, Math.min(index, list.length - 1))] || null;
}

export function buildDerivedState(state) {
  const worker = selectedItem(state.workers, state.workerIndex);
  const route = selectedItem(state.routes, state.routeIndex);
  const selectedCwd = selectedItem(state.cwdOptions, state.cwdIndex);
  const selectedThread = selectedItem(state.threadOptions, state.threadIndex);
  return {
    selectedWorkerLabel: worker ? (worker.name || worker.id || worker.guid) : "未读取 PC Rabi",
    selectedWorkerMeta: worker
      ? `${worker.online ? "在线" : "离线"} · ${worker.guid || worker.id || ""}`
      : "连接 Relay 后显示",
    selectedRouteLabel: route ? (route.name || route.id) : "未读取 Route",
    selectedRouteMeta: route
      ? `${route.running ? "运行中" : "未运行"} · ${(route.agentAdapters || []).join(", ") || "agent 未设置"}`
      : "选择 PC 后读取",
    selectedCwdLabel: selectedCwd || "未读取工作区",
    selectedThreadLabel: selectedThread || "未读取会话",
    bindingPreview: buildBindingPreview(state, route)
  };
}

export function buildBindingPreview(state, route) {
  if (!route) return "未选择 Route";
  if (state.agentAdapter === "codex") {
    return `${route.name || route.id} -> Codex · ${selectedItem(state.cwdOptions, state.cwdIndex) || "未选工作区"} · ${selectedItem(state.threadOptions, state.threadIndex) || "未选会话"}`;
  }
  if (state.agentAdapter === "copilotCli") {
    return `${route.name || route.id} -> Copilot CLI · ${state.copilotCwd || "未填工作区"}`;
  }
  if (state.agentAdapter === "marvis") {
    return `${route.name || route.id} -> Marvis · ${state.marvisAppId || "未填 App ID"}`;
  }
  return `${route.name || route.id} -> AstrBot · ${state.astrbotUrl || "未填 URL"}`;
}

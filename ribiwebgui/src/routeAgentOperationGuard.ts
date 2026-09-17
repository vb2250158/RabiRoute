export function routeAgentOperationGuard(
  gatewayId: string,
  targetId: string,
  current: () => { gatewayId?: string; targetId?: string }
): () => void {
  return () => {
    const selected = current();
    if (selected.gatewayId !== gatewayId || selected.targetId !== targetId) {
      throw new Error("路线或主控 Agent 已切换，已停止后续操作。已返回的任务绑定保留在原路线草稿中，请回到原路线核对并保存。");
    }
  };
}

export type RouteActivationFeedback = Readonly<{
  state?: string;
  gateways?: readonly Readonly<{ unavailableInstances?: readonly string[] }>[];
}>;

/** Persistence and native activation are separate acknowledgements; neither one discards an editable draft. */
export function routeActivationSaveMessage(activation?: RouteActivationFeedback, recovered = false): string {
  if (activation?.state === "uncertain") return "当前路线已保存，运行生效待确认";
  if (activation?.state === "rejected") return "当前路线已保存，运行端未应用本次更新";
  if (activation?.state === "failed") return "当前路线已保存，运行生效失败";
  if (activation?.gateways?.some(item => item.unavailableInstances?.length)) return "当前路线已保存，部分入口不可用";
  if (activation?.state === "applied") return "当前路线已保存并生效";
  if (activation?.state === "requested") return "当前路线已保存，等待运行端生效";
  return recovered ? "已确认当前路线保存成功" : "当前路线已保存";
}

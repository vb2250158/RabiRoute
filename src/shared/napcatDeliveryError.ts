const failureAdvice = {
  NAPCAT_LOGIN_REQUIRED: { message: "当前 NapCat 实例的 QQ 登录态已失效，本次请求未发到 QQ。请用绑定账号在此实例登录卡片扫码。", recoveryAction: "scan-bound-account-qr" },
  QQ_PERMISSION_DENIED: { message: "QQ 明确拒绝了此操作的权限，请核对原账号和目标会话权限。", recoveryAction: "check-account-and-conversation-permissions" },
  RABI_ROUTE_PERMISSION_DENIED: { message: "当前 Route 的发送规则禁止此操作，请检查该 Route 的输出开关和允许的消息类型。", recoveryAction: "check-route-output-policy" },
  NAPCAT_AUTHENTICATION_FAILED: { message: "NapCat 接口认证被拒绝，请检查当前实例的访问凭据。", recoveryAction: "check-instance-authentication" },
  NAPCAT_CONNECTION_FAILED: { message: "连接 NapCat 失败，QQ 登录状态尚未证实，请检查当前实例和接口地址。", recoveryAction: "inspect-instance-connection" },
  NAPCAT_DELIVERY_FAILED: { message: "NapCat 投递失败，请核对原回执后处理。", recoveryAction: "inspect-original-receipt" }
} as const;

export type NapCatFailureCode = keyof typeof failureAdvice;
export function napcatFailureAdvice(code: NapCatFailureCode) { return { code, ...failureAdvice[code] }; }

/** Safe protocol fields for receipts; raw upstream text can contain private paths. */
export class NapCatRequestError extends Error {
  constructor(message: string, readonly diagnostic: {
    action: string; kind: "http" | "rejected" | "transport" | "invalid_response";
    httpStatus?: number; retcode?: number; transportCode?: string;
    code?: NapCatFailureCode; message?: string; recoveryAction?: string;
    platformResult?: "not_sent" | "rejected" | "unknown";
  }) { super(message); this.name = "NapCatRequestError"; }
}

/** Read legacy receipts too, without admitting raw upstream text into public diagnostics. */
export function projectNapCatDeliveryError(value: unknown): NapCatRequestError["diagnostic"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.action !== "string" || !/^[a-zA-Z0-9_]{1,100}$/.test(data.action)
    || !["http", "rejected", "transport", "invalid_response"].includes(String(data.kind))) return undefined;
  const result: NapCatRequestError["diagnostic"] = { action: data.action, kind: data.kind as NapCatRequestError["diagnostic"]["kind"] };
  for (const key of ["httpStatus", "retcode"] as const) if (Number.isSafeInteger(data[key])) result[key] = data[key] as number;
  if (typeof data.transportCode === "string" && /^(UND_ERR_[A-Z_]+|E[A-Z0-9_]+)$/.test(data.transportCode)) result.transportCode = data.transportCode;
  if (typeof data.code === "string" && Object.hasOwn(failureAdvice, data.code)) Object.assign(result, napcatFailureAdvice(data.code as NapCatFailureCode));
  if (data.platformResult === "not_sent" || data.platformResult === "rejected" || data.platformResult === "unknown") result.platformResult = data.platformResult;
  return result;
}

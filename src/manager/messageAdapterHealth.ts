export type AdapterOperationalState =
  | "healthy"
  | "degraded"
  | "offline"
  | "needs_login"
  | "unconfigured"
  | "unknown"
  | "timeout"
  | "error";

export type AdapterOperationalHealth = {
  state: AdapterOperationalState;
  message: string;
  available?: number;
  total?: number;
};

export type MessageAdapterScanLike = {
  type: string;
  label: string;
  maturity?: string;
  installed: boolean;
  requirements?: Array<{
    id: string;
    label?: string;
    required?: boolean;
    ok?: boolean;
    detail?: string;
  }>;
  scan?: {
    state: "ok" | "timeout" | "error";
    durationMs: number;
    message?: string;
  };
};

export type IndependentAdapterHealthSummary = {
  adapters: Record<string, AdapterOperationalHealth>;
  overall: {
    state: "healthy" | "degraded" | "unknown";
    message: string;
  };
};

type NapcatHealthPayload = Record<string, {
  instances?: Record<string, Record<string, any>>;
}>;

function summarizeNapcat(napcatHealth: NapcatHealthPayload): AdapterOperationalHealth {
  const instances = Object.values(napcatHealth)
    .flatMap((gateway) => Object.values(gateway.instances ?? {}))
    .filter((instance) => instance.enabled !== false);
  if (instances.length === 0) {
    return {
      state: "unconfigured",
      message: "没有启用的 QQ / NapCat 实例。"
    };
  }

  const healthy = instances.filter((instance) => instance.ok === true);
  const timedOut = instances.filter((instance) => instance.scanState === "timeout");
  const failed = instances.filter((instance) => instance.scanState === "error");
  const needsLogin = instances.filter((instance) =>
    ["manual-login", "qr-login-required", "quick-login-available", "login-conflict", "account-mismatch"]
      .includes(String(instance.state || ""))
  );

  if (healthy.length === instances.length) {
    return {
      state: "healthy",
      available: healthy.length,
      total: instances.length,
      message: `QQ / OneBot ${healthy.length}/${instances.length} 可用；NapCat WebUI 仅用于诊断和配置，不参与可收发判定。`
    };
  }
  if (healthy.length > 0) {
    return {
      state: "degraded",
      available: healthy.length,
      total: instances.length,
      message: `QQ / OneBot ${healthy.length}/${instances.length} 可用；其余 QQ 实例分别显示自己的状态。`
    };
  }
  if (timedOut.length === instances.length) {
    return {
      state: "timeout",
      available: 0,
      total: instances.length,
      message: "QQ / OneBot 检查超时；没有把超时推断为离线。"
    };
  }
  if (failed.length === instances.length) {
    return {
      state: "error",
      available: 0,
      total: instances.length,
      message: "QQ / OneBot 检查失败；没有把探针失败推断为登录状态。"
    };
  }
  if (needsLogin.length > 0) {
    const webuiReachable = instances.some((instance) => instance.webui?.reachable === true);
    return {
      state: "needs_login",
      available: 0,
      total: instances.length,
      message: webuiReachable
        ? "NapCat WebUI 可访问，但这不代表 OneBot 已登录或可收发；当前 QQ 需要独立完成登录。"
        : "当前 QQ / OneBot 未登录；这只影响 QQ 入口。"
    };
  }
  return {
    state: "offline",
    available: 0,
    total: instances.length,
    message: "当前没有可用的 QQ / OneBot 实例；其他消息入口保持独立。"
  };
}

function summarizeGeneric(scan: MessageAdapterScanLike): AdapterOperationalHealth {
  if (scan.scan?.state === "timeout") {
    return {
      state: "timeout",
      message: `${scan.label} 检查超时；没有据此推断入口离线。`
    };
  }
  if (scan.scan?.state === "error") {
    return {
      state: "error",
      message: `${scan.label} 检查失败：${scan.scan.message || "未知错误"}`
    };
  }

  const required = scan.requirements?.filter((item) => item.required) ?? [];
  const missing = required.filter((item) => item.ok === false);
  const loginMissing = missing.find((item) => item.id === "login" || /登录/.test(item.id));
  if (loginMissing) {
    return {
      state: "needs_login",
      message: `${scan.label} 未登录；只影响此入口。`
    };
  }
  if (missing.length > 0) {
    return {
      state: scan.installed ? "degraded" : "unconfigured",
      message: `${scan.label} 有 ${missing.length} 项必需条件未满足；只影响此入口。`
    };
  }
  if (scan.installed) {
    return {
      state: "healthy",
      message: `${scan.label} 当前检查通过。`
    };
  }
  return {
    state: "unknown",
    message: `${scan.label} 尚无足够证据判断运行状态。`
  };
}

export function summarizeIndependentAdapterHealth(input: {
  adapters: Record<string, MessageAdapterScanLike>;
  napcatHealth?: NapcatHealthPayload;
}): IndependentAdapterHealthSummary {
  const adapters: Record<string, AdapterOperationalHealth> = {};
  for (const [type, scan] of Object.entries(input.adapters)) {
    adapters[type] = type === "napcat"
      ? summarizeNapcat(input.napcatHealth ?? {})
      : summarizeGeneric(scan);
  }

  const values = Object.values(adapters);
  const healthyCount = values.filter((health) => health.state === "healthy").length;
  const unresolvedCount = values.filter((health) => health.state === "unknown").length;
  const issueCount = values.length - healthyCount - unresolvedCount;
  if (issueCount > 0) {
    return {
      adapters,
      overall: {
        state: "degraded",
        message: `${issueCount} 个独立消息入口需要处理；其他入口状态不受影响。`
      }
    };
  }
  if (healthyCount > 0 && unresolvedCount === 0) {
    return {
      adapters,
      overall: {
        state: "healthy",
        message: "所有已扫描消息入口均正常。"
      }
    };
  }
  return {
    adapters,
    overall: {
      state: "unknown",
      message: "部分消息入口证据不足；各入口仍按独立状态展示。"
    }
  };
}

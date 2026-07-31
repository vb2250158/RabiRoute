import {
  runBoundedScans,
  type BoundedScanTask,
  type ScanDiagnostic
} from "../manager/scanController.js";

export type NapcatHealthScanEntry = Record<string, any> & {
  ok: boolean;
  enabled: boolean;
  scanState: "ok" | "timeout" | "error" | "skipped";
};

export type NapcatHealthScanPayload = Record<string, {
  instances: Record<string, NapcatHealthScanEntry>;
}>;

export type NapcatHealthScanContext<Runtime, Instance> = {
  runtimes: Iterable<Runtime>;
  gatewayId(runtime: Runtime): string;
  instances(runtime: Runtime): Instance[];
  instanceId(instance: Instance): string;
  instanceEnabled(instance: Instance): boolean;
  instanceMetadata(instance: Instance): Record<string, unknown>;
  testHealth(runtime: Runtime, instance: Instance): Promise<Record<string, unknown>>;
};

type InstanceProbe = {
  gatewayId: string;
  instanceId: string;
  health: NapcatHealthScanEntry;
};

function timeoutHealth(
  diagnostic: ScanDiagnostic,
  metadata: Record<string, unknown>
): NapcatHealthScanEntry {
  const timeout = diagnostic.state === "timeout";
  return {
    ...metadata,
    ok: false,
    enabled: true,
    state: timeout ? "scan-timeout" : "scan-error",
    scanState: diagnostic.state,
    needsUserAction: false,
    message: timeout
      ? "NapCat / OneBot 健康检查超过本轮截止时间；其他消息端结果已先返回。"
      : `NapCat / OneBot 健康检查失败：${diagnostic.message || "未知错误"}`
  };
}

/**
 * Read-only NapCat observation. This module intentionally has no lifecycle,
 * config-write, login, or repair dependency.
 */
export async function scanNapcatHealthReadOnly<Runtime, Instance>(
  context: NapcatHealthScanContext<Runtime, Instance>,
  options: { deadlineMs: number }
): Promise<{
  payload: NapcatHealthScanPayload;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
}> {
  const payload: NapcatHealthScanPayload = {};
  const tasks: Array<BoundedScanTask<string, InstanceProbe>> = [];

  for (const runtime of context.runtimes) {
    const gatewayId = context.gatewayId(runtime);
    payload[gatewayId] = { instances: {} };
    for (const instance of context.instances(runtime)) {
      const instanceId = context.instanceId(instance);
      const metadata = context.instanceMetadata(instance);
      if (!context.instanceEnabled(instance)) {
        payload[gatewayId].instances[instanceId] = {
          ...metadata,
          ok: false,
          enabled: false,
          state: "disabled",
          scanState: "skipped",
          needsUserAction: false,
          message: "此 QQ 实例已停用，未执行网络探测。"
        };
        continue;
      }

      const key = `${encodeURIComponent(gatewayId)}::${encodeURIComponent(instanceId)}`;
      tasks.push({
        key,
        run: async () => ({
          gatewayId,
          instanceId,
          health: {
            ...metadata,
            ...await context.testHealth(runtime, instance),
            enabled: true,
            scanState: "ok"
          } as NapcatHealthScanEntry
        }),
        fallback: (diagnostic) => ({
          gatewayId,
          instanceId,
          health: timeoutHealth(diagnostic, metadata)
        })
      });
    }
  }

  const bounded = await runBoundedScans(tasks, options);
  for (const probe of Object.values(bounded.values) as InstanceProbe[]) {
    payload[probe.gatewayId] ??= { instances: {} };
    payload[probe.gatewayId].instances[probe.instanceId] = probe.health;
  }

  return {
    payload,
    diagnostics: bounded.diagnostics,
    partial: bounded.partial,
    durationMs: bounded.durationMs,
    deadlineMs: bounded.deadlineMs
  };
}

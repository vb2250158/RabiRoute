import { nextHeartbeatScheduleTime } from "@rabiroute/host-api/scheduling/heartbeatSchedules";
import { automationRunId, claimAutomationRun, finishAutomationRun } from "@rabiroute/host-api/automation/personaAutomationRuntime";
import type { PersonaAutomationRuleDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { armScheduleTask, clearScheduleTasks, type ScheduleTimerContext } from "../adapters/scheduleTaskTimer.js";
import { renderTemplate } from "@rabiroute/host-api/routing/agentPacket";

export type RoleScheduledTask = { sourceRoleId: string; rawRuleId: string; storageOwner: string; rule: PersonaAutomationRuleDefinition & { trigger: { type: "schedule" } }; timer?: NodeJS.Timeout; nextAt?: Date };
export type RoleAutomationSource = {
  readScheduleSnapshot(): Promise<{ revision: string; tasks: RoleScheduledTask[]; warnings: readonly unknown[] }>;
  subscribeChanged(listener: () => void): () => void;
  acquireTaskLease(sourceRoleId: string, expectedStorageOwner: string): Promise<{ assertCurrent(): void; release(): Promise<void> }>;
};
export type RoleAutomationSchedulerPorts = {
  source: RoleAutomationSource;
  deliver(task: RoleScheduledTask, runId: string, assertCurrent: () => void, scheduledAt: Date): Promise<{ statusCode: number; data: Record<string, unknown> }>;
  diagnostic(event: string, detail: Record<string, unknown>): void;
  now?: () => Date;
  setTimer?: ScheduleTimerContext<RoleScheduledTask>["setTimer"];
  clearTimer?: ScheduleTimerContext<RoleScheduledTask>["clearTimer"];
  claim?: typeof claimAutomationRun;
  finish?: typeof finishAutomationRun;
};

function failureDetail(error: unknown): Record<string, unknown> {
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; uncertain?: unknown } : {};
  const safeMessages = ["The target instance is offline or disabled.", "Peer Manager task transport is unavailable.", "Original role automation storage owner changed.", "Role automation scheduler is retiring."];
  return {
    code: typeof value.code === "string" && /^[A-Z0-9_]{1,100}$/.test(value.code) ? value.code : "ROLE_AUTOMATION_DELIVERY_ERROR",
    message: safeMessages.includes(String(value.message)) ? value.message : "Scheduled DSBot delivery was not confirmed; inspect its original delivery receipt.",
    uncertain: value.uncertain === true
  };
}

/** Preserves business text and existing placeholder rendering without persona envelopes. */
export function roleAutomationMessage(task: RoleScheduledTask, scheduledAt: Date): string {
  if (task.rule.action.type !== "deliver_agent") throw new Error("Role schedule requires Agent delivery.");
  const message = task.rule.action.message?.trim() || `定时任务触发：${task.rule.name?.trim() || task.rawRuleId}`;
  const schedule = task.rule.trigger.schedule;
  const template = renderTemplate(task.rule.action.template || "", {
    message, rawMessage: message, roleId: task.sourceRoleId, sourceRoleId: task.sourceRoleId,
    automationRuleId: task.rawRuleId, automationRuleName: task.rule.name || task.rawRuleId,
    scheduleId: schedule.id, scheduleName: schedule.name || schedule.id, scheduledAt: scheduledAt.toISOString()
  }).trim();
  return [message, template && template !== message ? `[用户模板补充]\n${template}` : ""].filter(Boolean).join("\n\n");
}

/** Independent role execution uses the gateway's timer core and original execution ledger. */
export function createRoleAutomationScheduler(ports: RoleAutomationSchedulerPorts) {
  let accepting = false;
  let retiring: Promise<void> | undefined;
  let tasks: RoleScheduledTask[] = [];
  let unsubscribe = () => {};
  let revision = "";
  let refresh: Promise<void> | undefined;
  let refreshAgain = false;
  const flights = new Set<Promise<void>>();
  const assertCurrent = () => { if (!accepting) throw new Error("Role automation scheduler is retiring."); };
  const timer: ScheduleTimerContext<RoleScheduledTask> = {
    get active() { return accepting; }, now: ports.now ?? (() => new Date()), nextScheduleTime: nextHeartbeatScheduleTime,
    setTimer: ports.setTimer ?? ((callback, delay) => setTimeout(callback, delay)), clearTimer: ports.clearTimer ?? (handle => clearTimeout(handle)), changed() {},
    runTask(task, scheduledAt) {
      if (!accepting) return;
      const sourceId = `role-automation:${Buffer.from(task.sourceRoleId).toString("base64url")}`;
      const runId = automationRunId(sourceId, task.rawRuleId, { scheduledAt });
      const metadata = { sourceRoleId: task.sourceRoleId, automationRuleId: task.rawRuleId, scheduledAt: scheduledAt.toISOString(), triggerType: "schedule" };
      const flight = Promise.resolve().then(async () => {
        assertCurrent();
        const lease = await ports.source.acquireTaskLease(task.sourceRoleId, task.storageOwner);
        try {
          const assertDeliveryCurrent = () => { assertCurrent(); lease.assertCurrent(); };
          assertDeliveryCurrent();
          if (!(ports.claim ?? claimAutomationRun)(runId, metadata)) return;
          try {
            const result = await ports.deliver(task, runId, assertDeliveryCurrent, scheduledAt);
            const receipt = result.data.dsBot as { state?: unknown } | undefined;
            const state = receipt?.state;
            const status = result.data.uncertain === true || state === "uncertain" ? "uncertain"
              : state === "conflict" || state === "not_found" ? state
              : result.statusCode >= 200 && result.statusCode < 300 && state === "accepted" ? "accepted"
              : result.statusCode >= 200 && result.statusCode < 300 ? "uncertain" : "failed";
            (ports.finish ?? finishAutomationRun)(runId, status, { ...metadata, statusCode: result.statusCode });
            if (status !== "accepted") ports.diagnostic("role_automation_delivery_unconfirmed", { ...metadata, status, statusCode: result.statusCode });
          } catch (error) {
            const detail = failureDetail(error);
            const knownOffline = detail.message === "The target instance is offline or disabled." || detail.message === "Peer Manager task transport is unavailable.";
            (ports.finish ?? finishAutomationRun)(runId, knownOffline && !detail.uncertain ? "failed" : "uncertain", { ...metadata, ...detail });
            throw error;
          }
        } finally { await lease.release(); }
      }).catch(error => ports.diagnostic("role_automation_delivery_failed", { ...metadata, ...failureDetail(error) }));
      flights.add(flight); void flight.finally(() => flights.delete(flight));
    }
  };
  const refreshTasks = () => {
    if (!accepting) return Promise.resolve();
    refreshAgain = true;
    if (refresh) return refresh;
    refresh = (async () => {
      while (accepting && refreshAgain) {
        refreshAgain = false;
        const snapshot = await ports.source.readScheduleSnapshot();
        if (!accepting) return;
        if (snapshot.revision === revision) continue;
        clearScheduleTasks(tasks, timer);
        tasks = snapshot.tasks.map(task => ({ ...task }));
        revision = snapshot.revision;
        if (snapshot.warnings.length) ports.diagnostic("role_automation_source_warnings", { warnings: snapshot.warnings });
        for (const task of tasks) {
          try { armScheduleTask(task, timer); }
          catch (error) { ports.diagnostic("role_automation_schedule_invalid", { sourceRoleId: task.sourceRoleId, automationRuleId: task.rawRuleId, ...failureDetail(error) }); }
        }
      }
    })().finally(() => { refresh = undefined; });
    return refresh;
  };
  return {
    async start() {
      if (retiring) throw new Error("Role automation scheduler is retired.");
      accepting = true;
      unsubscribe = ports.source.subscribeChanged(() => { void refreshTasks().catch(() => ports.diagnostic("role_automation_source_unavailable", {})); });
      await refreshTasks();
    },
    stop() {
      accepting = false;
      unsubscribe(); clearScheduleTasks(tasks, timer);
      return retiring ??= (async () => { await Promise.allSettled([...(refresh ? [refresh] : []), ...flights]); })();
    }
  };
}

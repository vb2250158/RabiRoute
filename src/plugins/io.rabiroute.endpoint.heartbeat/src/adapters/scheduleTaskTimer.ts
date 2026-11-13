import { nextHeartbeatScheduleTime } from "@rabiroute/host-api/scheduling/heartbeatSchedules";
import type { NotificationScheduleDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";

export type ScheduledTimerTask = { rule: { trigger: { schedule: NotificationScheduleDefinition } }; timer?: NodeJS.Timeout; nextAt?: Date };
export type ScheduleTimerContext<T extends ScheduledTimerTask> = {
  active: boolean;
  now(): Date;
  nextScheduleTime: typeof nextHeartbeatScheduleTime;
  setTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  runTask(task: T, scheduledAt: Date): void;
  changed(): void;
};

/** Arms one task using the same clock and repeat semantics in Manager and gateway. */
export function armScheduleTask<T extends ScheduledTimerTask>(task: T, context: ScheduleTimerContext<T>, lastScheduledAt?: Date): void {
  if (!context.active) return;
  const now = context.now();
  const nextAt = context.nextScheduleTime(task.rule.trigger.schedule, now, { lastScheduledAt });
  task.nextAt = nextAt ?? undefined;
  if (!nextAt) { context.changed(); return; }
  const delay = Math.max(0, Math.min(2_147_483_647, nextAt.getTime() - now.getTime()));
  task.timer = context.setTimer(() => {
    task.timer = undefined;
    if (!context.active) return;
    if (context.now().getTime() + 1000 < nextAt.getTime()) { armScheduleTask(task, context, lastScheduledAt); return; }
    context.runTask(task, nextAt);
    if (context.active) armScheduleTask(task, context, nextAt);
  }, delay);
  context.changed();
}

/** Clears scheduled callbacks; the caller separately joins already admitted work. */
export function clearScheduleTasks<T extends ScheduledTimerTask>(tasks: readonly T[], context: Pick<ScheduleTimerContext<T>, "clearTimer">): void {
  for (const task of tasks) {
    if (task.timer) context.clearTimer(task.timer);
    task.timer = undefined;
    task.nextAt = undefined;
  }
}

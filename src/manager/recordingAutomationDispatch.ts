import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isReviewEvent, type AllDayEvent } from "../shared/allDayRecording.js";
import { RECORDING_CAPTURE_TYPES, type CaptureEventRouteKind } from "../shared/personaEventTypes.js";
import { SYSTEM_EVENT_RESULT_PREFIX, type SystemEventIngress } from "../shared/systemEventIngress.js";

type RecordingAutomationInput = SystemEventIngress & { routeKind: CaptureEventRouteKind };
export function recordingAutomationInput(roleId: string, event: AllDayEvent): RecordingAutomationInput | undefined {
  const type = RECORDING_CAPTURE_TYPES.find(type => type.value === event.source);
  if (!type || event.state !== "saved" || !isReviewEvent(event)) return;
  return {
    routeKind: type.routeKind,
    record: { time: event.startedAt / 1000, messageId: event.id, rawMessage: event.text.trim().slice(0, 4096) || type.title,
      senderName: type.title, source: event.source, adapterType: "recording", routeProfileId: roleId },
    templateValues: { recordingEventId: event.id, recordingSource: event.source, recordingKind: event.kind }
  };
}

export class RecordingAutomationDispatch {
  private readonly queue: { roleId: string; gatewayId: string; input: RecordingAutomationInput }[] = [];
  private readonly children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  private readonly admitted = new Set<string>();
  private disposed = false;
  constructor(private readonly gateways: (roleId: string, routeKind: CaptureEventRouteKind) => string[],
    private readonly spawn: (gatewayId: string) => ChildProcessWithoutNullStreams,
    private readonly report: (roleId: string, reason: string) => void) {}

  accept(roleId: string, event: AllDayEvent): void {
    if (this.disposed) return;
    const input = recordingAutomationInput(roleId, event);
    if (!input) return;
    for (const gatewayId of this.gateways(roleId, input.routeKind)) {
      const key = JSON.stringify([roleId, gatewayId, event.id]);
      if (this.admitted.has(key)) continue;
      if (this.queue.length >= 32) { this.report(roleId, "queue_full"); break; }
      this.admitted.add(key);
      if (this.admitted.size > 512) this.admitted.delete(this.admitted.values().next().value!);
      this.queue.push({ roleId, gatewayId, input });
    }
    this.drain();
  }

  private drain(): void {
    while (!this.disposed && this.children.size < 2 && this.queue.length) {
      const { roleId, gatewayId, input } = this.queue.shift()!;
      if (!this.gateways(roleId, input.routeKind).includes(gatewayId)) continue;
      let child: ChildProcessWithoutNullStreams;
      try { child = this.spawn(gatewayId); }
      catch { this.report(roleId, "spawn_failed"); continue; }
      let stdout = "";
      const timeout = setTimeout(() => { child.kill(); }, 120_000);
      timeout.unref();
      child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-16_384); });
      child.stderr.resume();
      child.on("error", () => { this.report(roleId, "process_error"); });
      child.stdin.on("error", () => { child.kill(); });
      const closed = new Promise<void>(resolve => child.once("close", code => {
        clearTimeout(timeout);
        this.children.delete(child);
        if (!this.disposed && (code !== 0 || !stdout.includes(SYSTEM_EVENT_RESULT_PREFIX))) this.report(roleId, "delivery_unconfirmed");
        resolve();
        this.drain();
      }));
      this.children.set(child, closed);
      child.stdin.end(JSON.stringify(input));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue.length = 0;
    for (const child of this.children.keys()) child.kill();
    await Promise.all([...this.children.values()]);
  }
}

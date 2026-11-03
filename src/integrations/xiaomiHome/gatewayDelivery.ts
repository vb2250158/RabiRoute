import { spawn, type ChildProcess } from "node:child_process";
import { gatewayAdapterTypes, type GatewayDefinition } from "../../shared/gatewayConfigModel.js";
import { routeRuntimeParts, sanitizeRoleId } from "../../shared/routeIdentity.js";
import { getTimeoutMs } from "../../shared/timeoutSettings.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";
import { XiaomiHomeEventLedger } from "./eventLedger.js";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import type { XiaomiHomeRequestAuthority } from "./requestAuthority.js";

export type XiaomiHomeGatewayDeliveryResult = {
  gatewayId?: string;
  status: "delivered" | "routed" | "missed" | "failed" | "skipped";
  matchedRuleCount: number;
  sentPacketCount: number;
  reason?: string;
  adapterOutcomes?: Array<{ adapter?: string; status?: string; error?: string }>;
};

export type XiaomiHomeGatewayExecution = Readonly<{
  rootDir: string;
  routeSnapshots: () => readonly Readonly<{ definition: GatewayDefinition }>[];
  childCommand: (args: string[]) => Readonly<{ command: string; args: string[]; shell: boolean }>;
  environmentForGateway: (definition: GatewayDefinition) => NodeJS.ProcessEnv;
  appendLog: (gatewayId: string, message: string) => void;
}>;

const resultPrefix = "RABIROUTE_XIAOMI_HOME_DELIVERY_RESULT:";

export function parseXiaomiHomeEventCliDelivery(stdout: string): XiaomiHomeGatewayDeliveryResult | null {
  const line = stdout.split(/\r?\n/).reverse().find(item => item.startsWith(resultPrefix));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(resultPrefix.length)) as Partial<XiaomiHomeGatewayDeliveryResult>;
    if (!parsed.status || !Number.isFinite(parsed.matchedRuleCount) || !Number.isFinite(parsed.sentPacketCount)) return null;
    return {
      status: parsed.status,
      matchedRuleCount: Number(parsed.matchedRuleCount),
      sentPacketCount: Number(parsed.sentPacketCount),
      reason: parsed.reason,
      adapterOutcomes: Array.isArray(parsed.adapterOutcomes) ? parsed.adapterOutcomes : []
    };
  } catch { return null; }
}

/** The platform owns its ledger, event routing and delivery workers; the host supplies existing Route execution resources. */
export function createXiaomiHomeGatewayDelivery(execution: XiaomiHomeGatewayExecution, roleDirectory: (roleId: string) => string) {
  const ledger = new XiaomiHomeEventLedger(roleDirectory);
  const children = new Map<ChildProcess, Promise<void>>();
  const pending = new Set<Promise<XiaomiHomeGatewayDeliveryResult[]>>();
  let closed = false;
  let retirement: Promise<void> | undefined;
  const assertActive = () => {
    if (closed) throw new XiaomiHomeManagerApiError(503, "xiaomi_home_runtime_stopped", "Xiaomi Home event delivery has retired.");
  };

  function deliverViaGateway(definition: GatewayDefinition, event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext): Promise<XiaomiHomeGatewayDeliveryResult> {
    assertActive();
    return new Promise(resolve => {
      const command = execution.childCommand(["--xiaomi-home-event-stdin"]);
      const child = spawn(command.command, command.args, {
        cwd: execution.rootDir, env: execution.environmentForGateway(definition), shell: command.shell, windowsHide: true
      });
      const childClosed = new Promise<void>(resolve => child.once("close", () => { children.delete(child); resolve(); }));
      children.set(child, childClosed);
      let stdout = "";
      let settled = false;
      const finish = (result: XiaomiHomeGatewayDeliveryResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        execution.appendLog(definition.id, `xiaomi home event delivery status=${result.status} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish({ gatewayId: definition.id, status: "failed", matchedRuleCount: 0, sentPacketCount: 0, reason: "delivery_process_timeout" });
      }, getTimeoutMs("deadline.manager.controlPlaneRoutes.deliverXiaomiHomeEventViaGateway", 10 * 60 * 1000));
      child.stdout!.on("data", data => { if (stdout.length < 256 * 1024) stdout += data.toString(); });
      child.stderr!.resume();
      child.on("error", () => finish({ gatewayId: definition.id, status: "failed", matchedRuleCount: 0, sentPacketCount: 0, reason: "delivery_process_spawn_failed" }));
      child.on("exit", () => {
        const delivery = parseXiaomiHomeEventCliDelivery(stdout);
        finish(delivery ? { gatewayId: definition.id, ...delivery } : {
          gatewayId: definition.id, status: "failed", matchedRuleCount: 0, sentPacketCount: 0,
          reason: closed ? "delivery_plugin_retired" : "delivery_process_no_result"
        });
      });
      child.stdin!.on("error", () => { /* Process termination owns the original delivery result. */ });
      child.stdin!.end(JSON.stringify({ event, context }));
    });
  }

  async function deliver(event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext, access?: XiaomiHomeRequestAuthority): Promise<XiaomiHomeGatewayDeliveryResult[]> {
    assertActive();
    access?.assert();
    try {
      access?.dispatch();
      await ledger.append(sanitizeRoleId(context.agentRoleId), event);
    } catch {
      access?.assert();
      // The ledger audits its failure; routing retains its existing availability.
    }
    assertActive();
    access?.assert();
    const roleId = sanitizeRoleId(context.agentRoleId);
    const candidates = roleId ? execution.routeSnapshots().filter(({ definition }) => definition.enabled !== false
      && (sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId) === roleId
      && gatewayAdapterTypes(definition).includes("xiaomiHome")) : [];
    if (!candidates.length) return [{ status: "missed", matchedRuleCount: 0, sentPacketCount: 0, reason: "no_matching_xiaomi_home_gateway" }];
    const deliveries = candidates.map(({ definition }) => { access?.dispatch(); return deliverViaGateway(definition, event, context); });
    try {
      const results = await Promise.all(deliveries);
      access?.assert();
      return results;
    } catch (error) { access?.assert(); throw error; }
  }

  return Object.freeze({
    deliverEvent(event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext, access?: XiaomiHomeRequestAuthority) {
      const work = deliver(event, context, access);
      pending.add(work);
      return work.finally(() => pending.delete(work));
    },
    stop(): Promise<void> {
      closed = true;
      return retirement ??= (async () => {
        for (const child of children.keys()) child.kill();
        await Promise.allSettled([...pending, ...children.values()]);
        await ledger.drain();
      })();
    }
  });
}

import { createRoleAutomationScheduler, roleAutomationMessage } from "./src/manager/roleAutomationScheduler.js";

export function createOwnedRuntime(ports) {
    return Object.freeze({
        readOnly: ports.managerReadOnly,
        createScheduler(source) {
            return createRoleAutomationScheduler({
                source,
                diagnostic: (event, detail) => ports.managerOperationalLog.record("warn", event, detail),
                async deliver(task, runId, assertCurrent, scheduledAt) {
                    const target = task.rule.action.target;
                    if (task.rule.action.type !== "deliver_agent" || target?.kind !== "ds_bot") throw new Error("Role automation requires an explicit DSBot destination.");
                    const request = {
                        action: "ds_bot_deliver", agentAdapter: "dsh",
                        dsBot: { botScopeId: target.botScopeId, botId: target.botId, scheduledAt: scheduledAt.toISOString() },
                        deliveryId: runId, prompt: roleAutomationMessage(task, scheduledAt),
                        ...(target.instanceBinding ? { instanceBinding: target.instanceBinding } : { agentTargetId: target.agentTargetId }),
                        ...(target.dshBaseUrl ? { dshBaseUrl: target.dshBaseUrl } : {})
                    };
                    assertCurrent();
                    return ports.handleAgentThreadRequest(request, ports.agentThreadRequestOptions(request, { requestAuthority: assertCurrent }));
                }
            });
        }
    });
}

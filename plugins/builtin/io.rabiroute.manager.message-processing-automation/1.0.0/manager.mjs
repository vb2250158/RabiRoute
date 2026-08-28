import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.message-processing-automation@1");
        context.services.provide("manager.message-processing-automation@1", Object.freeze({ instanceId: context.identity.instanceId }));
        for (const contribution of [])
            context.contributions.register(contribution);
        context.effects.add(async () => {
            const pendingEffects = [];
            const disposers = [];
            const disposeStartedEffects = async () => {
                let firstError;
                for (const dispose of [...disposers].reverse()) {
                    try { await dispose(); } catch (error) { firstError ??= error; }
                }
                if (firstError) throw firstError;
            };
            const ctx = Object.freeze({
                effect(starter, label) {
                    const pending = Promise.resolve().then(starter).then(dispose => {
                        if (typeof dispose !== "function") throw new Error(`Plugin effect did not return a disposer: ${label ?? "effect"}.`);
                        disposers.push(dispose);
                        return dispose;
                    });
                    pendingEffects.push(pending);
                    return pending;
                }
            });
            try {
        if (runtime.managerReadOnly)
            return () => { };
        const automation = new runtime.MessageProcessingAutomationService({
            listExistingRequests: () => runtime.agentRequests.list(),
            getRequest: requestId => runtime.agentRequests.get(requestId),
            deliverReminder: runtime.deliverAgentRequestReminder,
            onError: runtime.recordAgentRequestReminderFailure
        });
        const knowledgeReminders = new runtime.KnowledgeCallbackReminderService({
            listExisting: () => runtime.messageProcessingBoard.list({ limit: 500 }),
            getRecord: requirementId => runtime.messageProcessingBoard.getRequirement(requirementId),
            isPending: requirement => Boolean(requirement.knowledgeCallbackDueAt
                && runtime.messageProcessingBoard.pendingKnowledgeMatches(requirement.id).length),
            deliverReminder: runtime.deliverKnowledgeCallbackReminder,
            completeAttempt: requirement => runtime.messageProcessingBoard.pendingKnowledgeMatches(requirement.id).length
                ? runtime.messageProcessingBoard.recordKnowledgeReminder(requirement.id)
                : undefined,
            onError: (error, requirement) => {
                runtime.managerOperationalLog.record("warn", "knowledge_callback_reminder_failed", {
                    action: requirement?.id ?? "unknown",
                    error: runtime.managerOperationalError(error, runtime.rootDir)
                });
            }
        });
        let unsubscribePlanUpdates = () => { };
        let disposed = false;
        const dispose = async () => {
            if (disposed)
                return;
            disposed = true;
            unsubscribePlanUpdates();
            if (runtime.messageProcessingAutomationService === automation)
                runtime.messageProcessingAutomationService = undefined;
            if (runtime.knowledgeCallbackReminderService === knowledgeReminders)
                runtime.knowledgeCallbackReminderService = undefined;
            await Promise.all([automation.stop(), knowledgeReminders.stop()]);
        };
        ctx.effect(() => dispose, "stop Manager message processing automation plugin");
        runtime.messageProcessingAutomationService = automation;
        runtime.knowledgeCallbackReminderService = knowledgeReminders;
        try {
            unsubscribePlanUpdates = runtime.subscribePlanUpdates(event => {
                void runtime.handleMessageProcessingPlanUpdate(event.roleDir, event.after);
            });
            automation.start();
            await knowledgeReminders.start();
        }
        catch (error) {
            await dispose();
            throw error;
        }

                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.message-processing-automation");
    }
}).activate;

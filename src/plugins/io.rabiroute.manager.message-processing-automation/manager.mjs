import { createImplementation, hostModules } from "./manager-runtime.mjs";
import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
    async activate(context) {
        const shared = context.services.require("host.manager.message-processing-automation@2");
        await shared.prepareModules(hostModules);
        const runtime = createImplementation(shared).createOwnedRuntime(shared);
        context.services.provide("manager.message-processing-automation@1", Object.freeze({ instanceId: context.identity.instanceId }));
        if (runtime.managerReadOnly) return;

        const knowledgeReminders = new runtime.KnowledgeCallbackReminderService({
            listExisting: () => runtime.messageProcessingBoard.list({ limit: 500 }),
            getRecord: requirementId => runtime.messageProcessingBoard.getRequirement(requirementId),
            isPending: requirement => Boolean(requirement.knowledgeCallbackDueAt
                && runtime.messageProcessingBoard.pendingKnowledgeMatches(requirement.id).length),
            deliverReminder: runtime.deliverKnowledgeCallbackReminder,
            completeAttempt: requirement => runtime.messageProcessingBoard.pendingKnowledgeMatches(requirement.id).length
                ? runtime.messageProcessingBoard.recordKnowledgeReminder(requirement.id) : undefined,
            onError: (error, requirement) => runtime.managerOperationalLog.record("warn", "knowledge_callback_reminder_failed", {
                action: requirement?.id ?? "unknown", error: runtime.managerOperationalError(error, runtime.rootDir)
            })
        });
        let previousKnowledge;
        let unsubscribe = () => {};
        let accepting = false;
        let starting;
        let retiring;
        const planFlights = new Set();
        const retire = () => {
            accepting = false;
            return retiring ??= Promise.resolve().then(async () => {
                if (runtime.knowledgeCallbackReminderService === knowledgeReminders) runtime.knowledgeCallbackReminderService = undefined;
                const results = await Promise.allSettled([
                    Promise.resolve().then(() => unsubscribe()),
                    Promise.resolve().then(() => knowledgeReminders.stop()),
                    // Startup's error is reported at the publication boundary.
                    Promise.resolve(starting).catch(() => {}),
                    ...planFlights
                ]);
                previousKnowledge = undefined;
                const failure = results.find(result => result.status === "rejected");
                if (failure) throw failure.reason;
            });
        };
        context.effects.add(() => retire, "prepare Manager message processing automation");
        context.publication.add({
            publish() {
                previousKnowledge = runtime.knowledgeCallbackReminderService;
                runtime.knowledgeCallbackReminderService = knowledgeReminders;
            },
            rollback() {
                if (runtime.knowledgeCallbackReminderService === knowledgeReminders) runtime.knowledgeCallbackReminderService = previousKnowledge;
                previousKnowledge = undefined;
            },
            afterPublish({ previousRetirement, signal }) {
                let cancelled;
                const cancellation = new Promise((_, reject) => {
                    cancelled = () => reject(signal.reason ?? new Error("Message processing automation startup cancelled."));
                    signal.addEventListener("abort", cancelled, { once: true });
                    if (signal.aborted) cancelled();
                });
                starting = (async () => {
                    // Start only after the previous knowledge callback owner retires.
                    await Promise.race([previousRetirement, cancellation]);
                    if (signal.aborted || retiring || runtime.knowledgeCallbackReminderService !== knowledgeReminders) return;
                    previousKnowledge = undefined;
                    accepting = true;
                    unsubscribe = runtime.subscribePlanUpdates(event => {
                        if (!accepting || signal.aborted) return;
                        const flight = Promise.resolve().then(() => runtime.handleMessageProcessingPlanUpdate(event.roleDir, event.after))
                            .catch(error => runtime.managerOperationalLog.record("warn", "message_processing_plan_update_failed", {
                                error: runtime.managerOperationalError(error, runtime.rootDir)
                            }));
                        planFlights.add(flight);
                        void flight.then(() => planFlights.delete(flight), () => planFlights.delete(flight));
                    });
                    await knowledgeReminders.start();
                })().finally(() => signal.removeEventListener("abort", cancelled));
                // Readiness may legitimately outlive the publication phase. Its
                // real task remains joined by retire, without occupying that queue.
                void starting.catch(error => {
                    if (!signal.aborted && !retiring) context.lifecycle.fail(error);
                });
            },
            retire
        }, "publish Manager message processing automation");
    }
}).activate;

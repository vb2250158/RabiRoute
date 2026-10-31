import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.plan-feedback-delivery@1");
        context.services.provide("manager.plan-feedback-delivery@1", Object.freeze({ instanceId: context.identity.instanceId }));
        if (runtime.managerReadOnly)
            return;
        // Restore persisted circuits only after the previous owner has finished writing them.
        const createRecovery = () => new runtime.PlanFeedbackRecoveryService({
            persistencePath: runtime.planFeedbackFailureStatePath,
            onPersistenceError: error => {
                runtime.managerOperationalLog.record("warn", "background_failure_state_persist_failed", {
                    action: "plan-feedback-recovery",
                    error: runtime.managerOperationalError(error, runtime.rootDir)
                });
            },
            listCandidates: signal => runtime.managerReadWorkerPool.queryPlanFeedbackRecoveryCandidates(runtime.rolesRoot, { signal }),
            recoverCandidate: async (candidate, controls) => {
                const outcome = await runtime.recoverPlanFeedbackCandidate(candidate, {
                    signal: controls.signal,
                    inspect: runtime.inspectPlanFeedbackDelivery,
                    schedule: async (current) => {
                        await controls.scheduleOnce(() => runtime.scheduleAndWaitForPlanFeedbackDelivery(current.roleDir, current.roleId, String(current.feedback.gatewayId || "").trim(), current.plan, current.feedback));
                    }
                });
                controls.signal.throwIfAborted();
                if (outcome.state === "delivered") {
                    runtime.publishManagerEvent("plan_feedback_changed", {
                        roleId: candidate.roleId,
                        planId: candidate.plan.id,
                        feedbackId: outcome.record.id
                    });
                }
                return outcome;
            },
            onSummary: summary => {
                runtime.managerOperationalLog.record("info", "plan_feedback_recovery_sweep", {
                    action: summary.reason,
                    result: `candidates=${summary.candidates}; delivered=${summary.delivered}; scheduled=${summary.scheduled}; deferred=${summary.deferred}; alreadyAttempted=${summary.alreadyAttempted}`
                });
            },
            onError: event => {
                runtime.managerOperationalLog.record("warn", "plan_feedback_recovery_failed", {
                    action: event.recoveryKey ? `${event.reason}:${event.recoveryKey}` : event.reason,
                    error: runtime.managerOperationalError(event.error, runtime.rootDir),
                    result: `${event.stage === "scan" && event.error instanceof runtime.ManagerReadWorkerError
                        ? event.error.code
                        : event.stage}; phase=${event.circuit.snapshot.phase}; failures=${event.circuit.snapshot.consecutiveFailures}; signature=${event.circuit.snapshot.signature}; retryAt=${new Date(event.circuit.snapshot.retryAt).toISOString()}`
                });
            },
            onIncident: event => {
                runtime.managerOperationalLog.record("error", "plan_feedback_recovery_incident_opened", {
                    action: event.recoveryKey ? `${event.reason}:${event.recoveryKey}` : event.reason,
                    error: runtime.managerOperationalError(event.error, runtime.rootDir),
                    result: `incidentId=${event.circuit.snapshot.incidentId}; stage=${event.stage}; signature=${event.circuit.snapshot.signature}; failures=${event.circuit.snapshot.consecutiveFailures}; retryAt=${new Date(event.circuit.snapshot.retryAt).toISOString()}`
                });
            }
        });
        let recovery;
        let previous;
        let ready = false;
        let startRequested = false;
        let retirement;
        const owns = () => runtime.startActivePlanFeedbackRecovery === start;
        const start = () => {
            startRequested = true;
            if (!ready || !owns() || context.lifecycle.signal.aborted)
                return;
            void recovery.start("plan and route readiness").catch(error => {
                if (!context.lifecycle.signal.aborted)
                    context.lifecycle.fail(error);
            });
        };
        context.publication.add({
            publish() {
                previous = {
                    active: runtime.planFeedbackDeliveryActive,
                    recovery: runtime.planFeedbackRecoveryService,
                    start: runtime.startActivePlanFeedbackRecovery,
                    started: runtime.planFeedbackRecoveryService?.isActive() ?? false
                };
                runtime.startActivePlanFeedbackRecovery = start;
                runtime.planFeedbackDeliveryActive = false;
                runtime.planFeedbackRecoveryService = undefined;
            },
            rollback() {
                if (!owns())
                    return;
                runtime.planFeedbackDeliveryActive = previous.active;
                runtime.planFeedbackRecoveryService = previous.recovery;
                runtime.startActivePlanFeedbackRecovery = previous.start;
            },
            async afterPublish({ signal, previousRetirement }) {
                await previousRetirement;
                signal.throwIfAborted();
                recovery = createRecovery();
                runtime.planFeedbackRecoveryService = recovery;
                runtime.planFeedbackDeliveryActive = true;
                ready = true;
                if (startRequested || previous.started)
                    start();
            },
            retire() {
                return retirement ??= (async () => {
                    ready = false;
                    if (owns()) {
                        runtime.planFeedbackDeliveryActive = false;
                        runtime.startActivePlanFeedbackRecovery = () => { };
                        if (runtime.planFeedbackRecoveryService === recovery)
                            runtime.planFeedbackRecoveryService = undefined;
                    }
                    if (recovery) {
                        const acceptedFlights = new Set(runtime.activePlanFeedbackDeliveryFlights.values());
                        try {
                            await recovery.stopAndJoin();
                        } finally {
                            for (const flight of runtime.activePlanFeedbackDeliveryFlights.values())
                                acceptedFlights.add(flight);
                            await Promise.allSettled([...acceptedFlights]);
                        }
                    }
                })();
            }
        }, "publish Manager plan feedback delivery owner");
    }
}).activate;

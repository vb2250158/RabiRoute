import { definePlugin } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({
    async activate(context) {
        const runtime = context.services.require("host.manager.plan-feedback-delivery@1");
        context.services.provide("manager.plan-feedback-delivery@1", Object.freeze({ instanceId: context.identity.instanceId }));
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
        runtime.planFeedbackDeliveryActive = true;
        const recovery = new runtime.PlanFeedbackRecoveryService({
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
        runtime.planFeedbackRecoveryService = recovery;
        const start = () => { void recovery.start("plan and route readiness"); };
        runtime.startActivePlanFeedbackRecovery = start;
        ctx.effect(() => async () => {
            runtime.planFeedbackDeliveryActive = false;
            if (runtime.startActivePlanFeedbackRecovery === start)
                runtime.startActivePlanFeedbackRecovery = () => { };
            await recovery.stop();
            await Promise.allSettled([...runtime.activePlanFeedbackDeliveryFlights.values()]);
            if (runtime.planFeedbackRecoveryService === recovery)
                runtime.planFeedbackRecoveryService = undefined;
        }, "stop Manager plan feedback delivery plugin");
                await Promise.all(pendingEffects);
                return disposeStartedEffects;
            } catch (error) {
                await Promise.allSettled(pendingEffects);
                await disposeStartedEffects().catch(() => {});
                throw error;
            }
        }, "activate io.rabiroute.manager.plan-feedback-delivery");
    }
}).activate;

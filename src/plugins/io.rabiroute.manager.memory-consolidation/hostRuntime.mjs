// Plugin-owned feature construction. Shared state enters through host ports.
import { MemoryConsolidationScheduler } from "./src/manager/memoryConsolidationScheduler.js";
export function createOwnedRuntime(ports) {
    function createMemoryConsolidationScheduler() {
        const failureStateRoot = ports.path.join(ports.projectDirectoryLayout(ports.rootDir).runtimeStateRoot, "background-failure-circuits");
        return new MemoryConsolidationScheduler({
            listTargets: ports.memoryConsolidationScheduleTargets,
            evaluate: (target, signal) => ports.evaluateMemoryConsolidationSchedule(target.roleDir, { signal, timeoutMs: ports.getTimeoutMs("backend.manager.controlPlaneRoutes.evaluate.evaluateMemoryConsolidationSchedule.timeoutMs", 30000) }),
            requestDueRun: async (target, dueOperationIdentity) => {
                if (!dueOperationIdentity)
                    return null;
                const committed = await ports.currentRoleStorageApplication().commands.requestMemoryConsolidation(target.roleId, { triggerSource: "auto" }, {
                    idempotencyKey: ports.roleStorageOperationKey("memory-consolidation-auto", target.roleId, dueOperationIdentity),
                    timeoutMs: ports.getTimeoutMs("backend.manager.controlPlaneRoutes.requestDueRun.currentRoleStorageApplication__.commands.requestMemoryConsolidation.timeoutMs", 30000)
                });
                const projection = committed.projection;
                return projection
                    ? {
                        runId: projection.run.id,
                        delivered: Boolean(projection.run.deliveredAt),
                        revision: projection.revision
                    }
                    : null;
            },
            deliver: ports.deliverAutomaticMemoryConsolidation,
            persistencePath: ports.path.join(failureStateRoot, "memory-consolidation.json"),
            onPersistenceError: (error) => {
                ports.managerOperationalLog.record("warn", "background_failure_state_persist_failed", {
                    action: "memory-consolidation",
                    error: ports.managerOperationalError(error, ports.rootDir)
                });
            },
            onError: (target, error, circuit) => {
                const runtime = ports.runtimes.get(target.gatewayId);
                const diagnostic = ports.memoryConsolidationFailureDiagnostic(error);
                if (runtime) {
                    ports.appendLog(runtime, `automatic memory consolidation failed; phase=${circuit.snapshot.phase}; failures=${circuit.snapshot.consecutiveFailures}; retryAt=${new Date(circuit.snapshot.retryAt).toISOString()}; ${diagnostic.runtimeLogSuffix}`);
                }
                ports.managerOperationalLog.record("error", "memory_consolidation_auto_failed", {
                    result: `gatewayId=${target.gatewayId}; phase=${circuit.snapshot.phase}; failures=${circuit.snapshot.consecutiveFailures}; signature=${circuit.snapshot.signature}; retryAt=${new Date(circuit.snapshot.retryAt).toISOString()}; ${diagnostic.runtimeLogSuffix}`,
                    error: diagnostic.operationalError
                });
            },
            onIncident: (target, error, circuit) => {
                const diagnostic = ports.memoryConsolidationFailureDiagnostic(error);
                ports.managerOperationalLog.record("error", "memory_consolidation_incident_opened", {
                    action: `gatewayId=${target.gatewayId}`,
                    result: `incidentId=${circuit.snapshot.incidentId}; signature=${circuit.snapshot.signature}; failures=${circuit.snapshot.consecutiveFailures}; retryAt=${new Date(circuit.snapshot.retryAt).toISOString()}; ${diagnostic.runtimeLogSuffix}`,
                    error: diagnostic.operationalError
                });
            }
        });
    }
    return Object.freeze({
        createMemoryConsolidationScheduler,
        managerReadOnly: ports.managerReadOnly,
        manualTriggerProcesses: ports.manualTriggerProcesses,
        get managerListenerReady() { return ports.managerListenerReady; },
        set managerListenerReady(value) { ports.managerListenerReady = value; },
        get memoryConsolidationScheduler() { return ports.memoryConsolidationScheduler; },
        set memoryConsolidationScheduler(value) { ports.memoryConsolidationScheduler = value; },
    });
}

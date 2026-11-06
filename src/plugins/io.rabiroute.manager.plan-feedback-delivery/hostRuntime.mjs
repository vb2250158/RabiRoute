// Plugin-owned feature construction. Shared state enters through host ports.
import { PlanFeedbackRecoveryService } from "./src/manager/planFeedbackRecoveryService.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        ManagerReadWorkerError: ports.ManagerReadWorkerError,
        PlanFeedbackRecoveryService,
        activePlanFeedbackDeliveryFlights: ports.activePlanFeedbackDeliveryFlights,
        inspectPlanFeedbackDelivery: ports.inspectPlanFeedbackDelivery,
        managerOperationalError: ports.managerOperationalError,
        managerOperationalLog: ports.managerOperationalLog,
        managerReadOnly: ports.managerReadOnly,
        managerReadWorkerPool: ports.managerReadWorkerPool,
        planFeedbackFailureStatePath: ports.path.join(ports.projectDirectoryLayout(ports.rootDir).runtimeStateRoot, "background-failure-circuits", "plan-feedback-recovery.json"),
        publishManagerEvent: ports.publishManagerEvent,
        recoverPlanFeedbackCandidate: ports.recoverPlanFeedbackCandidate,
        rootDir: ports.rootDir,
        scheduleAndWaitForPlanFeedbackDelivery: ports.scheduleAndWaitForPlanFeedbackDelivery,
        get managerListenerReady() { return ports.managerListenerReady; },
        set managerListenerReady(value) { ports.managerListenerReady = value; },
        get planFeedbackDeliveryActive() { return ports.planFeedbackDeliveryActive; },
        set planFeedbackDeliveryActive(value) { ports.planFeedbackDeliveryActive = value; },
        get planFeedbackRecoveryService() { return ports.planFeedbackRecoveryService; },
        set planFeedbackRecoveryService(value) { ports.planFeedbackRecoveryService = value; },
        get rolesRoot() { return ports.rolesRoot; },
        set rolesRoot(value) { ports.rolesRoot = value; },
        get startActivePlanFeedbackRecovery() { return ports.startActivePlanFeedbackRecovery; },
        set startActivePlanFeedbackRecovery(value) { ports.startActivePlanFeedbackRecovery = value; },
    });
}

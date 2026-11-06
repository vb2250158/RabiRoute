// Plugin-owned feature construction. Shared state enters through host ports.
import { createMessageProcessingOperations } from "./src/manager/messageProcessingOperations.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        managerPluginRoutes: ports.managerPluginRoutes,
        createMessageProcessingOperations: () => createMessageProcessingOperations({
            boardPayload: ports.messageProcessingBoardPayload,
            board: ports.messageProcessingBoard,
            sendContextReview: ports.messageProcessingSendContextReview,
            operationalLog: ports.managerOperationalLog,
            recallKnowledge: ports.recalledKnowledgeForMessage,
            verifyCriticalFactRecord: ({ roleId, requirement, disposition }) => ports.verifyCriticalProjectFactRecord({
                workspaceRoot: ports.rootDir,
                roleDir: roleId ? ports.roleDirForApi(roleId) : undefined,
                requirement,
                disposition
            }),
            setPlanBaseline: ports.setMessageProcessingPlanBaseline,
            scheduleKnowledgeCallbackReminder: ports.scheduleKnowledgeCallbackReminder,
            publishEvent: ports.publishManagerEvent
        }),
    });
}

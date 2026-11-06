// Plugin-owned feature construction. Shared state enters through host ports.
import { KnowledgeCallbackReminderService } from "./src/manager/knowledgeCallbackReminderService.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        KnowledgeCallbackReminderService,
        deliverKnowledgeCallbackReminder: ports.deliverKnowledgeCallbackReminder,
        handleMessageProcessingPlanUpdate: ports.handleMessageProcessingPlanUpdate,
        managerOperationalError: ports.managerOperationalError,
        managerOperationalLog: ports.managerOperationalLog,
        managerReadOnly: ports.managerReadOnly,
        messageProcessingBoard: ports.messageProcessingBoard,
        rootDir: ports.rootDir,
        subscribePlanUpdates: ports.subscribePlanUpdates,
        get knowledgeCallbackReminderService() { return ports.knowledgeCallbackReminderService; },
        set knowledgeCallbackReminderService(value) { ports.knowledgeCallbackReminderService = value; },
    });
}

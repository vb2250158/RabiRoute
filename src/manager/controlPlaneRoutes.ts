import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { normalizeAgentAdapters, parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";
import { agentThreadRequestFailureData, handleAgentThreadRequest, type AgentThreadRequest } from "../agentThreads.js";
import { AgentRequestStore, type AgentRequestRecord } from "../agentRequests/store.js";
import { agentRequestStatePath } from "../agentRequests/persistence.js";
import { listCodexDesktopThreads } from "../codexDesktopBridge.js";
import { isDshSessionId } from "../dshSessionBridge.js";
import { agentStateReportDecision } from "../agentAdapters/stateReportOrder.js";
import {
  deployAstrbotAdapter,
  getCopilotStatus,
  openMarvis,
  testAstrbotLogin as testAstrbotLoginEndpoint,
  type AgentManagerApiContext,
  type AstrbotLoginTestRequest,
  type MarvisOpenRequest
} from "../agentAdapters/managerApi.js";
import type { MessageAdapterType } from "../adapters/messageAdapter.js";
import type { ForwardRouteKind } from "../forwarding.js";
import { appendAdapterLogToDir } from "../history.js";
import {
  messageAgentPoolStatePath,
  readCurrentMessageAgentWorkers,
  replacePersistedMessageAgentWorker,
  resolveCurrentMessageAgentWorker
} from "../messageAgentPool.js";
import {
  resolveDeliveredMessageProcessingTarget,
  resolveMessageProcessingDeliveryTarget,
  type MessageProcessingDeliveryTarget
} from "./messageProcessingDeliveryTarget.js";
import { listDeliveryReplayAttempts } from "../deliveryReplayLedger.js";
import {
  autoLoginNapcatInstancesOnRabiStart,
  configureNapcatOneBot,
  ensureNapcatInstanceReady,
  launchNapcatInstance as launchNapcatInstanceEndpoint,
  nextFreeLocalPort,
  prepareManagedNapcatInstance,
  restartNapcatInstance as restartNapcatInstanceEndpoint,
  scanNapcatEndpoint,
  stopNapcatInstance as stopNapcatInstanceEndpoint,
  testNapcatHealth as testNapcatHealthEndpoint
} from "../messageEndpoints/napcatManager.js";
import {
  scanNapcatHealthReadOnly,
  type NapcatHealthScanPayload
} from "../messageEndpoints/napcatHealthScan.js";
import {
  scanFenneNoteEndpoint,
  scanRabiLinkEndpoint,
  scanWearableEndpoint,
  scanWebhookEndpoint,
  scanXiaoAiEndpoint
} from "../messageEndpoints/webhookLikeScans.js";
import { scanWeComEndpoint } from "../messageEndpoints/wecomManager.js";
import { RemoteAgentHub, type RemoteAgentTask, type RemoteAgentTaskEvent, type RemoteAgentTaskRequest } from "../messageEndpoints/remoteAgentManager.js";
import { appendMessageContextToDir, recentMessageContextItems } from "../messageContextStore.js";
import { SpeechIngressStore } from "../speechIngressStore.js";
import { managerRuntimeDiagnosticsSummary } from "../managerRuntimeDiagnostics.js";
import { createManagerOperationalLog, managerOperationalError } from "./operationalLog.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { PerformanceApi } from "./performanceRoutes.js";
import { measureSyncPerformanceOperation, recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import { readJsonlTail } from "./jsonlTail.js";
import { requestWeixinLogin } from "../weixinLoginRequest.js";
import { PersonaSyncService } from "../personaSync.js";
import { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import { PersonaSyncAutoReconciler } from "../personaSyncAutoReconciler.js";
import {
  findPersonaVoiceIdentity,
  listPersonaVoiceIdentities,
  updatePersonaVoiceIdentity,
  type PersonaVoiceIdentityPatch
} from "../personaVoiceIdentities.js";
import {
  listIdentityEndpointAccounts,
  listIdentityParticipants,
  listIdentityRelationCards,
  recordIdentityCandidateObservation,
  resolveIdentityRelationContext,
  updateIdentityRelation,
  type IdentityCandidateObservation,
  type IdentityRelationPatch
} from "../identityRelations.js";
import { listConversationSituations } from "../conversationSituationStore.js";
import type { ReviewedReplySourceEvidence } from "../replyImageDescriptions.js";
import {
  handleAgentSend,
  inspectAgentSendDelivery,
  prepareAgentSendRequest,
  validateAgentSendReplyImageDescriptions,
  type AgentSendRequest,
  type AgentSendResult
} from "../agentSend.js";
import { evaluateAgentSendLanguageStyle } from "../agentSendLanguageStyle.js";
import { agentSendRequestTemplateForSource } from "../agentSendTemplate.js";
import {
  MessageProcessingBoardStore,
  type MessageProcessingOutcomeInput,
  type KnowledgeMatchCallbackInput,
  type KnowledgeRecallMatch,
  type MessageProcessingRequirement,
  type MessageProcessingWorkerRuntimeObservation,
  type MessageProcessingWorkerRuntimeStatus,
  type RegisterMessageGroupRequirementInput
} from "../messageProcessing/board.js";
import {
  CoalescingMessageProcessingBoardPersistence,
  messageProcessingBoardStatePath
} from "../messageProcessing/persistence.js";
import {
  MessageProcessingSendContextReview,
  type MessageProcessingSendContextApprovalInput
} from "../messageProcessing/sendContextReview.js";
import {
  loadMessageProcessingContext,
  recoverReviewedMessageProcessingSourceRecord
} from "../messageProcessing/sourceContextRecovery.js";
import { normalizeCodexMemoryConsolidationAgentModel } from "../shared/codexMemoryConsolidationAgent.js";
import {
  agentSendReceiptResponse,
  executeIdempotentAgentSend,
  findAgentSendTraces,
  readAgentSendReceipt
} from "./agentSendIdempotency.js";
import { normalizePipelineDefinition, type PipelineDefinition } from "../pipelines.js";
import {
  normalizeRolePanelAttachments,
  readRolePanelTimeline,
  type RolePanelAttachment
} from "../rolePanelTimeline.js";
import {
  DEFAULT_CODEX_HOOK_SETTINGS,
  autoAssignGatewayPorts as sharedAutoAssignGatewayPorts,
  codexMessageProcessingAgentEnabled,
  definitionUsesNapcat as sharedDefinitionUsesNapcat,
  gatewayAdapterTypes as sharedGatewayAdapterTypes,
  normalizeCodexHookSettings,
  normalizeGatewayDefinition as sharedNormalizeGatewayDefinition,
  validateGatewayPortConflicts as sharedValidateGatewayPortConflicts,
  type CodexHookSettings,
  type CodexPlanAssistantSession,
  type CodexReasoningEffort,
  type MessageAdapterPolicies,
  type MessageProcessingAgentPolicies,
  type PersonaAutomationRuleDefinition,
  type RecentMessageLimits,
  type SpeechPushMode
} from "../shared/gatewayConfigModel.js";
import {
  codexPlanAssistantInitializationPrompt,
  normalizeCodexPlanAssistantModel,
  resolveCodexPlanAssistantTurnModel
} from "../shared/codexPlanAssistantSessions.js";
import {
  resolvePersistedProjectPath,
  resolveProjectPath,
  toPersistedProjectPath
} from "../shared/projectPaths.js";
import { normalizePathForComparison } from "../shared/pathPolicy.js";
import { rabiRoutePackageVersion } from "../packageInfo.js";
import {
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "../shared/routeIdentity.js";
import {
  adapterConfigPath as resolveAdapterConfigPath,
  roleFilePath,
  roleFolderPath,
  routeFolderPath,
  personaConfigPath as resolvePersonaConfigPath
} from "../shared/routePaths.js";
import { ManagerConfigRepository } from "./configRepository.js";
import { collectWatchedConfigFiles, configFilesSnapshot } from "./configWatchSnapshot.js";
import { configWatchDirectoryRules, configWatchEventMatches } from "./configWatchPolicy.js";
import { resolveCodexRuntimeState } from "./codexRuntimeState.js";
import { resolveReportedCodexBindingUpdate } from "./codexBindingUpdate.js";
import { handleDesktopLifecycleApi } from "./desktopLifecycleRoutes.js";
import { proxySpeechEventStream } from "./speechEventProxy.js";
import {
  CodexHookContextService,
  type AgentRequestStopResult,
  type CodexHookContextRequest,
  type PlanTaskCompletionDelivery
} from "./codexHookContext.js";
import { handleCodexHookApi } from "./codexHookRoutes.js";
import { handleLanguageStyleApi } from "./languageStyleRoutes.js";
import { LanguageStyleValidator } from "../languageStyleValidation.js";
import { createPlanTaskCompletionDelivery } from "./planTaskCompletionDelivery.js";
import {
  deliverPlanApprovalFeedback,
  PlanFeedbackDeliveryPendingError,
  type PlanApprovalFeedbackPersonaRequest,
  type PlanApprovalFeedbackSecretaryTarget
} from "./planApprovalFeedbackDelivery.js";
import {
  listOpenPlanFeedbackRecoveryCandidates,
  recoverPlanFeedbackCandidate,
  type PlanFeedbackRecoveryTaskRequest
} from "./planFeedbackRecovery.js";
import { resolvePlanSecretaryAssignment, type PlanSecretaryTarget } from "./planSecretaryAssignment.js";
import {
  ManualTriggerProcessRegistry,
  type ManualTriggerLaunchResult
} from "./manualTriggerProcess.js";
import {
  MemoryConsolidationScheduler,
  type DueMemoryConsolidationRun,
  type MemoryConsolidationScheduleTarget
} from "./memoryConsolidationScheduler.js";
import { consumePlanQaFeedback, type PlanQaTaskRequest } from "./planQaFeedback.js";
import { handlePlanAgentStatusApi } from "./planAgentStatusRoutes.js";
import { parseRoleKnowledgeResourceRoute } from "./roleKnowledgeRoute.js";
import { parseWearableHealthResourceRoute } from "./wearableHealthRoute.js";
import { RabiGlobalConfigStore, type RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import {
  generateWebguiAccessToken,
  isLoopbackRemoteAddress,
  isLocalMachineRemoteAddress,
  isPublicWebguiStaticRequest,
  isWebguiLanRequestAuthorized,
  lanAddressPriority,
  managerListensOnLan
} from "./webguiLanAccess.js";
import { handleRabiApi, publicRabiLinkRelayConfig } from "./rabiApi.js";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import {
  gatewayRuntimeSyncAction,
  managerAutostartEnabled,
  managerConfigWatcherEnabled,
  managerReadOnlyEnabled,
  managerReadOnlyRequestAllowed
} from "./managerRuntimeMode.js";
import { resolveGatewayChildCommand } from "./gatewayChildCommand.js";
import { BilibiliHistoryBridge } from "./bilibiliHistoryBridge.js";
import { handlePersonaAvatarApi } from "./personaAvatarRoutes.js";
import { handlePlanAttachmentApi } from "./planAttachmentRoutes.js";
import { roleInfoPayload } from "./roleInfoPayload.js";
import { summarizeIndependentAdapterHealth, type AdapterOperationalHealth } from "./messageAdapterHealth.js";
import { runBoundedScans, type ScanDiagnostic } from "./scanController.js";
import { PersonaSyncLanServer } from "./personaSyncLanServer.js";
import { handlePersonaSyncApi, type PersonaSyncRouteContext } from "./personaSyncRoutes.js";
import { handlePersonaVoiceTranscriptApi } from "./personaVoiceTranscriptRoutes.js";
import {
  ManagerReadWorkerError,
  managerAgentScanWorkerPool,
  managerCatalogWorkerPool,
  managerPerformanceWorkerPool,
  managerReadWorkerPool
} from "./managerReadWorkerPool.js";
import { handlePersonaMessagingApi } from "./personaMessagingRoutes.js";
import { PersonaCatalog } from "./personaCatalog.js";
import { loadPersonaMessageAuthority, type PersonaMessageAuthority } from "./personaMessageAuthority.js";
import { deliverRolePanelMessage, RolePanelDeliveryError } from "./rolePanelDelivery.js";
import { hostOwnedSpeechMessageCommand } from "./speechMessageIngress.js";
import {
  ManagerSpeechControl,
  SpeechControlError,
  speechControlErrorMessage,
  speechControlErrorStatus,
  type ManagerSpeechDeliveryOutcome
} from "./speechControl.js";
import {
  SelectionSpeechSettingsStore,
  selectionSpeechSettingsPath
} from "./selectionSpeechSettings.js";
import {
  DesktopSettingsStore,
  desktopSettingsPath
} from "./desktopSettings.js";
import type { DesktopSettings } from "../shared/desktopSettingsContract.js";
import {
  SpeechRuntimeControl,
  SpeechRuntimeControlError
} from "./speechRuntimeControl.js";
import {
  SpeechModelManager,
  SpeechModelManagerError
} from "./speechModelManager.js";
import {
  parseSpeechProcessResult,
  SPEECH_EXIT_DELIVERED,
  SPEECH_EXIT_RECORDED,
  SPEECH_PROCESS_RESULT_MARKER
} from "../speechMessageDelivery.js";
import type {
  SpeechAudioStreamSelectionCommand,
  SpeechIngressRecord,
  SpeechMessageCommand,
  SpeechMicrophoneSettingsCommand,
  SpeechMicrophoneStartCommand,
  SpeechPlaybackVolumeCommand,
  SpeechSpeakerBindingCommand,
  SpeechSpeakerIdentityCommand,
  SpeechSpeakerProfileCreateCommand,
  SpeechSpeakerProfileUpdateCommand,
  SpeechSynthesisCommand
} from "../shared/speechControlContract.js";
import type { LocalSpeechResponse } from "../speech/localSpeechClient.js";
import {
  gatewayPayloadIncludesConfigDefinitions,
  gatewayPayloadIncludesDiagnostics,
  standaloneGatewayPayload as buildStandaloneGatewayPayload
} from "./statusPayload.js";
import { handlePersonaDocumentApi } from "./personaDocumentRoutes.js";
import {
  applyMemoryConsolidationResult,
  createPlan,
  createRecentMemory,
  getPlan,
  getRoleSkill,
  listConsolidationRuns,
  planAcceptsGuidance,
  listPlans,
  listPlansAsync,
  listRecentMemories,
  listRoleSkills,
  markMemoryConsolidationRunDelivered,
  nextMemoryConsolidationTriggerAt,
  pendingMemoryConsolidation,
  presentRoleMemory,
  presentRoleMemories,
  roleKnowledgeSnapshot,
  subscribePlanUpdates,
  type PlanItem,
  updatePlan,
  updateRecentMemory,
  validateRoleKnowledge
} from "../roleKnowledge.js";
import {
  presentPlan,
  presentPlans,
  sortKnowledgeByUpdatedAt
} from "../roleKnowledgePresentation.js";
import {
  normalizeRoleMemoryPageLimit,
  normalizeRolePlanPageLimit,
  paginateRolePlans,
  summarizeRolePlan
} from "../roleKnowledgePagination.js";
import { verifyCriticalProjectFactRecord } from "../messageProcessing/criticalFactRecord.js";
import {
  appendPlanFeedback,
  createPlanFeedbackRecord,
  listPlanFeedback,
  planFeedbackResponseId,
  planFeedbackAttachmentsEqual,
  planFeedbackPlanAttachmentsEqual,
  planFeedbackSummary,
  resolvePlanFeedbackPlanAttachments,
  storePlanFeedbackAttachments,
  updatePlanFeedbackDelivery,
  type PlanFeedbackRecord
} from "../planFeedback.js";
import { resolvePlanAttachmentFile } from "../planAttachments.js";
import {
  PLAN_FEEDBACK_REQUEST_MAX_BYTES,
  type PlanFeedbackAttachmentUpload
} from "../shared/planFeedbackContract.js";
import { PLAN_ATTACHMENT_REQUEST_MAX_BYTES } from "../shared/planAttachmentContract.js";
import {
  currentWearableHealthState,
  ingestWearableHealthObservation,
  queryWearableHealthHistory,
  readWearableHealthConfig,
  summarizeWearableHealth,
  updateWearableHealthConfig,
  type WearableHealthMetric,
  type WearableHealthObservationInput
} from "../wearableHealth.js";
import {
  type WearableHealthAlertDeliveryContext
} from "../wearableHealthAlertDelivery.js";
import type { WearableHealthAlert } from "../wearableHealth.js";

type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  messageAdaptersDisabled?: MessageAdapterType[];
  messageInputsDisabled?: boolean;
  messageAdapterPolicies?: MessageAdapterPolicies;
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  fenneNoteWebhookPort?: number;
  fenneNoteWebhookPath?: string;
  xiaoaiWebhookPort?: number;
  xiaoaiWebhookPath?: string;
  rabiLinkWebhookPort?: number;
  rabiLinkWebhookPath?: string;
  rabiLinkWebhookHost?: string;
  rabiLinkRelayEnabled?: boolean;
  rabiLinkRelayUrl?: string;
  rabiLinkRelayToken?: string;
  rabiLinkRelayDeviceId?: string;
  rabiLinkRelayClaimWaitMs?: number;
  rabiLinkRelayReplyIdleTimeoutMs?: number;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomWsUrl?: string;
  weixinBaseUrl?: string;
  weixinBotType?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  feishuEncryptKey?: string;
  feishuEventSubscriptionEnabled?: boolean;
  feishuWebhookPort?: number;
  feishuWebhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  heartbeatSkipWhenAgentBusy?: boolean;
  personaAutomationScriptsEnabled?: boolean;
  remoteAgentDefaultDeviceId?: string;
  remoteAgentDefaultCwd?: string;
  remoteAgentDefaultThreadName?: string;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatWebuiToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
  ignoredNapcatInstanceIds?: string[];
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  routeVariables?: Record<string, string>;
  routeName?: string;
  agentModel?: string;
  agentReasoningEffort?: CodexReasoningEffort;
  codexThreadId?: string;
  codexThreadName?: string;
  codexCwd?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
  codexPlanAssistantEnabled?: boolean;
  codexPlanAssistantModel?: string;
  codexPlanAssistantSessions?: CodexPlanAssistantSession[];
  codexMemoryConsolidationAgentEnabled?: boolean;
  codexMemoryConsolidationAgentModel?: string;
  codexHooks?: CodexHookSettings;
  copilotThreadName?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  primaryAgentAdapter?: AgentAdapterType;
  messageProcessingAgents?: MessageProcessingAgentPolicies;
  routeProfiles?: RouteProfileDefinition[];
  dataDir?: string;
  groupNotificationTemplate?: string;
  groupAtNotificationTemplate?: string;
  groupDirectReplyNotificationTemplate?: string;
  groupIndirectReplyNotificationTemplate?: string;
  groupReplyNotificationTemplate?: string;
  groupNicknameNotificationTemplate?: string;
  privateNotificationTemplate?: string;
  heartbeatNotificationTemplate?: string;
  voiceTranscriptNotificationTemplate?: string;
  recentMessageLimit?: number;
  recentMessageLimits?: RecentMessageLimits;
  speechPushMode?: SpeechPushMode;
  speechTriggerKeywords?: string[];
  languageStyle?: import("../shared/languageStyle.js").LanguageStyleBinding;
  automationRules?: PersonaAutomationRuleDefinition[];
  notificationRules?: NotificationRuleDefinition[];
  roleNotificationRules?: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames?: Record<string, string>;
};

type RouteProfileDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  recentMessageLimit?: number;
  recentMessageLimits?: RecentMessageLimits;
  speechPushMode?: SpeechPushMode;
  speechTriggerKeywords?: string[];
  languageStyle?: import("../shared/languageStyle.js").LanguageStyleBinding;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  agentRoleId?: string;
  agentRoleFile?: string;
  rolesDir?: string;
  dataDir?: string;
  routeVariables?: Record<string, string>;
  automationRules?: PersonaAutomationRuleDefinition[];
  personaAutomationScriptsEnabled?: boolean;
  notificationRules?: NotificationRuleDefinition[];
};

type NotificationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  allowedSpeakerNames?: string[];
  regex?: string;
  schedules?: NotificationScheduleDefinition[];
  template: string;
};

type NotificationScheduleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  type: "interval" | "daily_time" | "once_at";
  intervalSeconds?: number;
  windowStartTime?: string;
  windowEndTime?: string;
  timeOfDay?: string;
  onceAt?: string;
};

type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

type GatewayRuntime = {
  definition: GatewayDefinition;
  process: ChildProcessWithoutNullStreams | null;
  needsRestart: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  agentStateGeneration?: string;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
  log: string[];
};

type AgentDeliverySource = NonNullable<AgentThreadRequest["deliverySource"]>;

function agentDeliverySourceForSession(
  sessionIdInput: unknown,
  sessionNameInput?: unknown,
  agentAdapter: AgentAdapterType = "codex"
): AgentDeliverySource {
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) throw new Error("Agent delivery source requires a source session id.");
  const sessionName = String(sessionNameInput || "").trim();
  return {
    agentAdapter: isDshSessionId(sessionId) ? "dsh" : agentAdapter,
    sessionId,
    ...(sessionName ? { sessionName } : {})
  };
}

function primaryAgentDeliverySource(definition: GatewayDefinition): AgentDeliverySource {
  const agentAdapter = definition.primaryAgentAdapter
    || normalizeAgentAdapters(definition.agentAdapters)[0]
    || "codex";
  const sessionId = agentAdapter === "dsh" ? definition.dshSessionId : definition.codexThreadId;
  const sessionName = agentAdapter === "dsh"
    ? definition.dshSessionName
    : definition.codexThreadName || definition.routeName || definition.name;
  return agentDeliverySourceForSession(sessionId, sessionName, agentAdapter);
}

type AgentRuntimeState = Record<string, unknown> & {
  agentAdapterType: AgentAdapterType;
};

type AgentStateReportRequest = {
  gatewayId?: string;
  adapterType?: AgentAdapterType;
  generation?: string;
  sequence?: number;
  state?: Record<string, unknown>;
};

type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  autoLoginOnRabiStart?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botNickname?: string;
};

type AgentMaturity = "verified" | "experimental" | "stub";

type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
};

type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean }>;
  warnings?: string[];
};

type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

type MessageAdapterScanResult = {
  type: Exclude<MessageAdapterType, "disabled">;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
  scan?: ScanDiagnostic;
  health?: AdapterOperationalHealth;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const managerPort = Number(process.env.GATEWAY_MANAGER_PORT ?? "8790");
const managerHttpLimits = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100
} as const;
const managerOperationalLog = createManagerOperationalLog({ rootDir });
const messageProcessingBoardPersistence = new CoalescingMessageProcessingBoardPersistence(
  messageProcessingBoardStatePath(rootDir)
);
const messageProcessingBoard = new MessageProcessingBoardStore(messageProcessingBoardPersistence);
const agentRequests = new AgentRequestStore(agentRequestStatePath(rootDir));
const agentRequestReminderTimers = new Map<string, NodeJS.Timeout>();
const managerRequestContexts = new WeakMap<http.ServerResponse, {
  requestId: string;
  method: string;
  pathname: () => string;
  startedAt: number;
  responseBytes?: number;
}>();
const rabiGlobalConfig = new RabiGlobalConfigStore(rootDir);
const managerReadOnly = managerReadOnlyEnabled();
const managerHostOverride = process.env.GATEWAY_MANAGER_HOST?.trim() || "";
const managerHost = managerHostOverride || (!managerReadOnly && rabiGlobalConfig.read().webguiLan.enabled ? "0.0.0.0" : "127.0.0.1");
const managerShouldAutostart = !managerReadOnly && managerAutostartEnabled();
const remoteAgentPublicHost = process.env.REMOTE_AGENT_PUBLIC_HOST || process.env.GATEWAY_MANAGER_PUBLIC_HOST || "";
const remoteAgentDiscoverable = process.env.REMOTE_AGENT_DISCOVERABLE !== "0";
const configRepository = new ManagerConfigRepository({ rootDir, managerPort });
const bilibiliHistoryBridge = new BilibiliHistoryBridge(
  path.join(rootDir, "data", "runtime", "bilibili-history-bridge.json"),
  () => configRepository.rolesRoot,
  { readOnly: managerReadOnly }
);
const managerEventStreams = new Set<http.ServerResponse>();

function publishManagerEvent(eventType: string, data: unknown): void {
  const frame = `event: ${eventType.replace(/[^a-zA-Z0-9_.:-]/g, "_")}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of [...managerEventStreams]) {
    if (stream.writableEnded || stream.destroyed) managerEventStreams.delete(stream);
    else stream.write(frame);
  }
}

function openManagerEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write("retry: 3000\n\nevent: ready\ndata: {}\n\n");
  managerEventStreams.add(response);
  // event-driven-allow: SSE protocol keepalive; no business state is queried.
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);
  keepAlive.unref();
  request.once("close", () => {
    clearInterval(keepAlive);
    managerEventStreams.delete(response);
  });
}

let personaSyncAutoReconciler: PersonaSyncAutoReconciler | undefined;

function relayReceiptText(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function relayReceiptAuditData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const state = relayReceiptText(data.state, 32);
  if (!new Set(["delivered", "played", "playback_failed"]).has(state)) return undefined;
  const deliveryId = relayReceiptText(data.deliveryId);
  const messageId = relayReceiptText(data.messageId);
  const deviceId = relayReceiptText(data.deviceId);
  if ((!deliveryId && !messageId) || !deviceId) return undefined;
  const receiptAt = Number(data.receiptAt);
  return {
    ...(messageId ? { messageId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    deviceId,
    deviceKind: relayReceiptText(data.deviceKind, 64),
    state,
    ...(Number.isFinite(receiptAt) && receiptAt > 0 ? { receiptAt } : {}),
    routeProfileId: relayReceiptText(data.routeProfileId)
  };
}

function routeOwnsRabiLinkReceipt(definition: GatewayDefinition, routeProfileId: string): boolean {
  const adapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  if (!adapters.includes("rabilink")) return false;
  if (!routeProfileId) return definition.enabled !== false;
  return definition.id === routeProfileId
    || (definition.routeProfiles ?? []).some((profile) => profile.id === routeProfileId);
}

function recordRabiLinkRelayReceipt(data: Record<string, unknown>): void {
  const receipt = relayReceiptAuditData(data);
  if (!receipt) return;
  const routeProfileId = String(receipt.routeProfileId || "");
  for (const runtime of runtimes.values()) {
    if (!routeOwnsRabiLinkReceipt(runtime.definition, routeProfileId)) continue;
    appendAdapterLogToDir("rabilink", {
      event: "outbox_receipt",
      message: `RabiLink device reported ${String(receipt.state)}.`,
      data: receipt
    }, dataDirFor(runtime.definition));
  }
  publishManagerEvent("rabilink_outbox_receipt", receipt);
}

const rabiLinkRelayRuntime = new RabiLinkRelayRuntime({
  onStatus: status => {
    publishManagerEvent("rabilink_status", status);
    personaSyncAutoReconciler?.noteRelayStatus(status.state);
  },
  onEvent: (eventType, data) => {
    personaSyncAutoReconciler?.noteRelayEvent(eventType);
    if (eventType === "outbox_receipt") recordRabiLinkRelayReceipt(data);
  }
});

type ManagerConfig = { routeDir?: string; rolesDir?: string };

function readManagerConfig(): ManagerConfig {
  return configRepository.readManagerConfig();
}

function writeManagerConfig(cfg: ManagerConfig): void {
  configRepository.writeManagerConfig(cfg);
  routeRoot = configRepository.routeRoot;
  rolesRoot = configRepository.rolesRoot;
  personaCatalog.invalidate();
}

let rolesRoot = configRepository.rolesRoot;
let routeRoot = configRepository.routeRoot;
const personaCatalog = new PersonaCatalog();
let personaMessageAuthority: PersonaMessageAuthority | undefined;
const messageProcessingSendContextReview = new MessageProcessingSendContextReview({
  getRequirement: (requirementId) => messageProcessingBoard.getRequirement(requirementId),
  findRequirementBySourceMessage: (routeId, messageId) => messageProcessingBoard.findLatestBySourceMessage(routeId, messageId),
  findRequirementsBySourceMessage: (routeId, messageId) => messageProcessingBoard.findBySourceMessage(routeId, messageId),
  loadContext: (requirement, sourceMessageId) => {
    const roleId = String(requirement.source.roleId || "").trim();
    if (!roleId) return [];
    return loadMessageProcessingContext({
      roleDir: roleDirForApi(roleId),
      requirement,
      sourceMessageId
    });
  }
});

function currentPersonaMessageAuthority(): PersonaMessageAuthority {
  personaMessageAuthority ??= loadPersonaMessageAuthority(rootDir);
  return personaMessageAuthority;
}
const codexHookContextService = new CodexHookContextService({
  rolesRoot: () => rolesRoot,
  storePath: path.join(rootDir, "data", "codex-hook", "sessions.json"),
  deliverPlanTaskCompletion,
  hookEnabled: codexHookEnabled,
  isManagedAgentSession,
  recordAgentRequestStop
});
const languageStyleValidator = new LanguageStyleValidator();
const fenneNotePlaybackUrl = process.env.FENNOTE_PLAYBACK_URL ?? "http://127.0.0.1:8793/api/fennenote/playback";
const fenneNoteReplyUrl = process.env.FENNOTE_REPLY_URL ?? "http://127.0.0.1:8793/api/fennenote/reply";
const fenneNotePlaybackToken = process.env.FENNOTE_PLAYBACK_TOKEN ?? "";
const fenneNoteReplyToken = process.env.FENNOTE_REPLY_TOKEN ?? fenneNotePlaybackToken;
const webuiDistPath = path.join(rootDir, "ribiwebgui", "dist");
const runtimes = new RuntimeRegistry();
const persistedPerformanceConfig = rabiGlobalConfig.read().performance;
const performanceMonitoring = new PerformanceMonitoringService(rootDir, managerReadOnly
  ? { ...persistedPerformanceConfig, enabled: false }
  : persistedPerformanceConfig);
const performanceApi = new PerformanceApi({
  service: performanceMonitoring,
  globalConfig: rabiGlobalConfig,
  gatewayExists: gatewayId => Boolean(runtimes.get(gatewayId)),
  readWorkerPool: managerPerformanceWorkerPool
});
let memoryConsolidationScheduler: MemoryConsolidationScheduler | undefined;
const planTaskCompletionDelivery = createPlanTaskCompletionDelivery<GatewayRuntime>({
  getRuntime: gatewayId => runtimes.get(gatewayId),
  listRuntimes: () => [...runtimes.values()],
  roleIdForDefinition,
  triggerRolePanelMessage: triggerGatewayRolePanelMessage,
  assignSecretary: (runtime, delivery) => ensurePlanSecretaryTarget(runtime, delivery.roleDir, delivery.plan).target,
  sendToSecretary: sendPlanTaskCompletionToSecretary,
  publishEvent: publishManagerEvent
});
const speechIngressStore = new SpeechIngressStore(
  path.join(rootDir, "data", "speech", "messages"),
  path.join(rootDir, "data", "speech", "deliveries")
);
const personaSyncService = new PersonaSyncService(
  () => rolesRoot,
  path.join(rootDir, "data", "persona-sync"),
  {
    readOnly: managerReadOnly,
    watch: managerShouldAutostart,
    reconcileOnQueryFallback: !managerReadOnly,
    onEvent: event => {
      publishManagerEvent("persona_sync_manifest_changed", event);
      personaSyncAutoReconciler?.noteManifestEvent(event);
    }
  }
);
const personaSyncCoordinator = new PersonaSyncCoordinator(
  personaSyncService,
  path.join(rootDir, "data", "persona-sync"),
  () => {
    const config = rabiGlobalConfig.read();
    const relay = rabiLinkRelayConfigForMeta();
    return {
      url: relay.url,
      token: relay.token,
      deviceId: relay.deviceId,
      deviceGuid: config.rabiGuid
    };
  }
);
personaSyncAutoReconciler = new PersonaSyncAutoReconciler(
  personaSyncCoordinator,
  path.join(rootDir, "data", "persona-sync"),
  {
    enabled: managerShouldAutostart,
    onStatus: status => publishManagerEvent("persona_sync_auto_status", status)
  }
);
function personaSyncRouteContext(controlPlaneAuthorized = false): PersonaSyncRouteContext {
  return {
    service: personaSyncService,
    coordinator: personaSyncCoordinator,
    autoReconciler: personaSyncAutoReconciler!,
    listConflicts: roleId => personaSyncService.listConflictsUsing(roleId, requestedRoleId =>
      managerCatalogWorkerPool.queryPersonaSyncConflicts(
        rolesRoot,
        path.join(rootDir, "data", "persona-sync"),
        requestedRoleId
      )),
    readOnlySnapshot: managerReadOnly,
    controlPlaneAuthorized,
    token: () => rabiLinkRelayConfigForMeta().token,
    relay: () => {
      const config = rabiGlobalConfig.read();
      const relay = rabiLinkRelayConfigForMeta();
      return {
        url: relay.url,
        token: relay.token,
        deviceId: relay.deviceId,
        deviceGuid: config.rabiGuid
      };
    }
  };
}
const personaSyncLanServer = new PersonaSyncLanServer(personaSyncRouteContext(), {
  port: Number(process.env.RABILINK_PERSONA_SYNC_LAN_PORT ?? 0),
  onStatus: status => publishManagerEvent("persona_sync_lan_status", status)
});
const selectionSpeechSettings = new SelectionSpeechSettingsStore(selectionSpeechSettingsPath(rootDir));
const desktopSettings = new DesktopSettingsStore(desktopSettingsPath(rootDir));
const speechControl = new ManagerSpeechControl({
  serviceUrl: () => speechServiceUrl(),
  rolesRoot: () => rolesRoot,
  route: (routeId) => {
    const runtime = runtimes.get(routeId);
    return runtime
      ? {
          id: runtime.definition.id,
          speechEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("speech"),
          rabiLinkEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("rabilink"),
          routeProfileIds: runtime.definition.routeProfiles?.map(profile => profile.id) ?? [runtime.definition.id]
        }
      : undefined;
  },
  routes: () => runtimes.values().map(runtime => ({
    id: runtime.definition.id,
    speechEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("speech"),
    rabiLinkEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("rabilink"),
    routeProfileIds: runtime.definition.routeProfiles?.map(profile => profile.id) ?? [runtime.definition.id]
  })),
  deliverTranscript: ({ routeId, record }) => {
    const runtime = runtimes.get(routeId);
    if (!runtime) return Promise.reject(new Error(`Speech Route disappeared before delivery: ${routeId}`));
    return triggerGatewaySpeechMessage(runtime, record);
  },
  appendRouteLog: (routeId, message) => {
    const runtime = runtimes.get(routeId);
    if (runtime) appendLog(runtime, message);
  },
  speechIngressStore
});
const speechRuntimeControl = new SpeechRuntimeControl({
  rootDir,
  serviceUrl: () => speechServiceUrl()
});
const agentStateByGateway = new Map<string, Partial<Record<AgentAdapterType, AgentRuntimeState>>>();
const remoteAgentToken = process.env.REMOTE_AGENT_TOKEN?.trim() || "";
const remoteAgentHub = new RemoteAgentHub({
  managerPort,
  managerHost,
  publicHost: remoteAgentPublicHost,
  discoveryPort: Number(process.env.REMOTE_AGENT_DISCOVERY_PORT ?? "8798"),
  passwordStorePath: path.join(rootDir, "data", "remote-agent-connections.json"),
  fileStoreDir: path.join(rootDir, "data", "remote-agent-files"),
  getDefaultGatewayId: () => [...runtimes.values()][0]?.definition.id,
  onTaskEvent: handleRemoteAgentTaskEvent,
  onConversationRecord: (record) => {
    const runtime = record.gatewayId ? runtimes.get(record.gatewayId) : undefined;
    if (!runtime) {
      console.warn(`Remote Agent conversation record skipped: Gateway not found (${record.gatewayId || "missing"})`);
      return;
    }
    try {
      appendMessageContextToDir(roleDirForDefinition(runtime.definition), record);
    } catch (error) {
      appendLog(runtime, `remote agent conversation record failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});
let watchedConfigSnapshot = "";

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function remoteAgentRequestToken(request: http.IncomingMessage, requestUrl: URL): string {
  const bearer = headerValue(request.headers.authorization).match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  return requestUrl.searchParams.get("token")?.trim()
    || headerValue(request.headers["x-remote-agent-token"]).trim()
    || bearer;
}

function isRemoteAgentRequestAuthorized(request: http.IncomingMessage, requestUrl: URL): boolean {
  if (isLoopbackRemoteAddress(request.socket.remoteAddress)) return true;
  if (isWebguiLanRequestAuthorized(request, requestUrl, rabiGlobalConfig.read().webguiLan)) return true;
  if (!remoteAgentToken) return false;
  return remoteAgentRequestToken(request, requestUrl) === remoteAgentToken;
}

function remoteRequestUsesIndependentAuthorization(request: http.IncomingMessage, requestUrl: URL): boolean {
  return requestUrl.pathname.startsWith("/api/remote-agent/")
    && isRemoteAgentRequestAuthorized(request, requestUrl);
}

function webguiLanRequestAllowed(request: http.IncomingMessage, requestUrl: URL): boolean {
  if (
    !managerListensOnLan(managerHost)
    || isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address))
  ) return true;
  if (isPublicWebguiStaticRequest(request.method, requestUrl.pathname)) return true;
  if (remoteRequestUsesIndependentAuthorization(request, requestUrl)) return true;
  return isWebguiLanRequestAuthorized(request, requestUrl, rabiGlobalConfig.read().webguiLan);
}

function definitionFingerprint(definition: GatewayDefinition): string {
  return JSON.stringify(definition);
}

function ensureDataDirs(): void {
  configRepository.ensureDataDirs();
  routeRoot = configRepository.routeRoot;
  rolesRoot = configRepository.rolesRoot;
}

function readConfig(): GatewayConfigFile {
  if (managerReadOnly) {
    routeRoot = configRepository.routeRoot;
    rolesRoot = configRepository.rolesRoot;
    if (!fs.existsSync(routeRoot)) return { gateways: [] };
  } else {
    ensureDataDirs();
  }
  const gateways: GatewayDefinition[] = [];
  for (const routeEntry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) {
      continue;
    }
    const configName = sanitizeRoleId(routeEntry.name);
    const configPath = adapterConfigPath(configName);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>;
    const personaConfig = readRoleMessageConfigItem(raw.agentRoleId, configName);
    gateways.push({
      ...raw,
      ...personaConfig,
      id: configName,
      configName,
      agentRoleId: raw.agentRoleId,
      rolesDir: raw.rolesDir,
      agentRoleFile: raw.agentRoleFile
    } as GatewayDefinition & { configName: string });
  }
  return { gateways };
}

function removeConfigFilesMissingFrom(activeConfigNames: Set<string>): void {
  ensureDataDirs();
  for (const routeEntry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) {
      continue;
    }
    const configName = sanitizeRoleId(routeEntry.name);
    if (!configName || activeConfigNames.has(configName)) {
      continue;
    }
    const configPath = adapterConfigPath(configName);
    if (fs.existsSync(configPath)) {
      try { fs.unlinkSync(configPath); } catch { /* non-fatal */ }
    }
  }
}

function removeGatewayConfig(id: string): void {
  ensureDataDirs();
  const decodedId = decodeURIComponent(id);
  const runtime = runtimes.get(decodedId);
  const configName = runtime
    ? sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName
    : routeRuntimeParts(decodedId).configName || sanitizeConfigName(decodedId);
  if (!configName) {
    throw new Error(`Invalid gateway id: ${decodedId}`);
  }
  const configPath = adapterConfigPath(configName);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Gateway config not found: ${decodedId}`);
  }
  fs.unlinkSync(configPath);
}

function writeConfig(config: GatewayConfigFile): GatewayConfigFile {
  if (!Array.isArray(config.gateways)) {
    throw new Error("routes must be an array");
  }

  const normalized = { gateways: config.gateways.map(normalizeDefinition) };
  sharedAutoAssignGatewayPorts(normalized.gateways, managerPort);
  sharedValidateGatewayPortConflicts(normalized.gateways);
  const grouped = new Map<string, GatewayDefinition[]>();
  const activeConfigNames = new Set<string>();
  for (let i = 0; i < normalized.gateways.length; i++) {
    const item = normalized.gateways[i];
    const rawItem = config.gateways[i];
    const roleId = sanitizeRoleId(item.agentRoleId) || routeRuntimeParts(item.id).roleId;
    const configName = sanitizeConfigName(item.configName) || routeRuntimeParts(item.id).configName;
    activeConfigNames.add(configName);
    grouped.set(roleId, [...(grouped.get(roleId) ?? []), item]);
    // Rename data dir if configName changed (look up existing runtime by original/raw id)
    const existingRuntime = runtimes.get(rawItem.id) ?? runtimes.get(item.id);
    if (existingRuntime) {
      const oldDataDir = dataDirFor(existingRuntime.definition);
      const newDataDir = dataDirFor(item);
      if (oldDataDir !== newDataDir && fs.existsSync(oldDataDir)) {
        try {
          fs.mkdirSync(path.dirname(newDataDir), { recursive: true });
          fs.renameSync(oldDataDir, newDataDir);
        } catch {
          // Non-fatal: folder rename failed (e.g. cross-drive), data stays at old location
        }
      }
      // Remove old config file if id (configName) changed
      const oldConfigName = routeRuntimeParts(existingRuntime.definition.id).configName;
      if (oldConfigName !== configName) {
        const oldConfigPath = adapterConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
    }
    writeAdapterConfigFile(item);
  }
  for (const [roleId, items] of grouped.entries()) {
    if (roleId) {
      writePersonaConfigFile(roleId, items);
    }
  }
  removeConfigFilesMissingFrom(activeConfigNames);
  return normalized;
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  return sharedNormalizeGatewayDefinition(definition, {
    managerPort,
    routeDataDir: (configName) => path.relative(rootDir, routeFolderPath(routeRoot, configName)).replace(/\\/g, "/"),
    rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/"),
    normalizeAgentAdapters: (adapters) => normalizeAgentAdapters(adapters),
    normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
  }) as GatewayDefinition;
}

function normalizeMessageAdapters(items: unknown[]): MessageAdapterType[] {
  const adapters = items
    .map((item) => item == null ? "" : String(item))
    .filter((item): item is MessageAdapterType => item === "napcat" || item === "remoteAgent" || item === "speech" || item === "fennenote" || item === "xiaoai" || item === "rabilink" || item === "wearable" || item === "webhook" || item === "wecom" || item === "heartbeat" || item === "rolePanel" || item === "disabled");
  const unique = [...new Set(adapters)].filter((item) => item !== "disabled");
  return unique.length > 0 ? unique : ["napcat"];
}

function sanitizeInstanceId(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[] {
  const source = Array.isArray(definition.napcatInstances) ? definition.napcatInstances : [];

  const used = new Set<string>();
  return source.map((item, index) => {
    const baseId = sanitizeInstanceId(item.id, `napcat-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    used.add(id);
    const gatewayPort = Number(item.gatewayPort || definition.gatewayPort || 8790 + index);
    assertValidPort(gatewayPort, `NapCat instance port for ${definition.id}/${id}`);
    return {
      id,
      name: item.name?.trim() || id,
      enabled: item.enabled !== false,
      autoLoginOnRabiStart: item.autoLoginOnRabiStart !== false,
      gatewayPort,
      httpUrl: item.httpUrl?.trim() || definition.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: item.webuiUrl?.trim() || definition.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
      accessToken: item.accessToken ?? definition.napcatAccessToken ?? "",
      webuiToken: item.webuiToken ?? definition.napcatWebuiToken ?? "",
      launchCommand: item.launchCommand?.trim() || undefined,
      workingDir: item.workingDir?.trim() || undefined
    };
  });
}

function normalizeCodexCwd(value: unknown): string | undefined {
  return resolvePersistedProjectPath(value, rootDir);
}

function resolveCodexThreadName(definition: GatewayDefinition): string {
  return definition.codexThreadName?.trim()
    || definition.routeName?.trim()
    || definition.name?.trim()
    || routeRuntimeParts(definition.id).configName
    || definition.id;
}

function resolveCopilotThreadName(definition: GatewayDefinition): string {
  return definition.copilotThreadName?.trim()
    || definition.routeName?.trim()
    || definition.name?.trim()
    || routeRuntimeParts(definition.id).configName
    || definition.id
    || "Copilot CLI";
}

function normalizeIgnoredNapcatInstanceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))];
}

function assertValidPort(value: unknown, label: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}. Port must be an integer from 1 to 65535.`);
  }
}

function personaConfigPath(roleId: string): string {
  return resolvePersonaConfigPath(rolesRoot, roleId);
}

function adapterConfigPath(configName: string): string {
  return resolveAdapterConfigPath(routeRoot, configName);
}

function definitionUsesNapcat(definition: GatewayDefinition): boolean {
  return sharedDefinitionUsesNapcat(definition);
}

function configPathValue(value: unknown): string | undefined {
  return toPersistedProjectPath(value, rootDir);
}

function adapterConfigItem(definition: GatewayDefinition): Record<string, unknown> {
  const usesNapcat = definitionUsesNapcat(definition);
  return {
    configName: sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName,
    name: definition.name,
    routeName: definition.routeName,
    enabled: definition.enabled !== false,
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: definition.messageAdaptersDisabled,
    messageInputsDisabled: definition.messageInputsDisabled,
    messageAdapterPolicies: definition.messageAdapterPolicies,
    pipelinePreset: definition.pipelinePreset,
    pipeline: definition.pipeline,
    gatewayPort: definition.gatewayPort,
    webhookPort: definition.webhookPort,
    webhookPath: definition.webhookPath,
    fenneNoteWebhookPort: definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: definition.xiaoaiWebhookPath,
    rabiLinkWebhookPort: definition.rabiLinkWebhookPort,
    rabiLinkWebhookPath: definition.rabiLinkWebhookPath,
    rabiLinkWebhookHost: definition.rabiLinkWebhookHost,
    feishuAppId: definition.feishuAppId,
    feishuAppSecret: definition.feishuAppSecret,
    feishuVerificationToken: definition.feishuVerificationToken,
    feishuEncryptKey: definition.feishuEncryptKey,
    feishuEventSubscriptionEnabled: definition.feishuEventSubscriptionEnabled === true,
    feishuWebhookPort: definition.feishuWebhookPort,
    feishuWebhookPath: definition.feishuWebhookPath,
    napcatHttpUrl: definition.napcatHttpUrl,
    napcatWebuiUrl: definition.napcatWebuiUrl,
    napcatAccessToken: definition.napcatAccessToken,
    napcatWebuiToken: definition.napcatWebuiToken,
    napcatInstances: usesNapcat && Array.isArray(definition.napcatInstances)
      ? definition.napcatInstances.map((instance) => ({
          ...instance,
          workingDir: configPathValue(instance.workingDir)
        }))
      : undefined,
    ignoredNapcatInstanceIds: normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds),
    heartbeatIntervalSeconds: definition.heartbeatIntervalSeconds,
    heartbeatMessage: definition.heartbeatMessage,
    heartbeatSkipWhenAgentBusy: definition.heartbeatSkipWhenAgentBusy,
    personaAutomationScriptsEnabled: definition.personaAutomationScriptsEnabled,
    remoteAgentDefaultDeviceId: definition.remoteAgentDefaultDeviceId,
    remoteAgentDefaultCwd: configPathValue(definition.remoteAgentDefaultCwd),
    remoteAgentDefaultThreadName: definition.remoteAgentDefaultThreadName,
    agentModel: definition.agentModel,
    agentReasoningEffort: definition.agentReasoningEffort,
    codexThreadId: definition.codexThreadId,
    codexThreadName: definition.codexThreadName,
    codexCwd: configPathValue(definition.codexCwd),
    codexPlanAssistantEnabled: definition.codexPlanAssistantEnabled,
    codexPlanAssistantModel: definition.codexPlanAssistantModel,
    codexPlanAssistantSessions: definition.codexPlanAssistantSessions,
    codexMemoryConsolidationAgentEnabled: definition.codexMemoryConsolidationAgentEnabled,
    codexMemoryConsolidationAgentModel: definition.codexMemoryConsolidationAgentModel,
    codexHooks: definition.codexHooks,
    messageProcessingAgents: definition.messageProcessingAgents,
    copilotThreadName: definition.copilotThreadName,
    copilotCwd: configPathValue(definition.copilotCwd),
    copilotCliBin: definition.copilotCliBin,
    marvisAppId: definition.marvisAppId,
    astrbotUrl: definition.astrbotUrl,
    astrbotUsername: definition.astrbotUsername,
    astrbotPassword: definition.astrbotPassword,
    astrbotProjectId: definition.astrbotProjectId,
    astrbotSessionId: definition.astrbotSessionId,
    rolesDir: configPathValue(definition.rolesDir),
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    agentAdapters: definition.agentAdapters,
    primaryAgentAdapter: definition.primaryAgentAdapter,
    speechPushMode: definition.speechPushMode,
    routeVariables: definition.routeVariables
  };
}

function hasGlobalRabiLinkRelayConfig(config = rabiGlobalConfig.read().rabiLinkRelay): boolean {
  return Boolean(config.url || config.token);
}

function rabiLinkRelayConfigFor(definition: GatewayDefinition): RabiLinkRelayGlobalConfig {
  const globalConfig = rabiGlobalConfig.read();
  const globalRelay = globalConfig.rabiLinkRelay;
  if (hasGlobalRabiLinkRelayConfig(globalRelay)) {
    return globalRelay;
  }
  const url = definition.rabiLinkRelayUrl?.trim() || "";
  const token = definition.rabiLinkRelayToken?.trim() || "";
  return {
    enabled: Boolean(url && token),
    url,
    token,
    deviceId: definition.rabiLinkRelayDeviceId?.trim() || globalRelay.deviceId || globalConfig.rabiName || definition.id,
    claimWaitMs: definition.rabiLinkRelayClaimWaitMs ?? globalRelay.claimWaitMs,
    replyIdleTimeoutMs: definition.rabiLinkRelayReplyIdleTimeoutMs ?? globalRelay.replyIdleTimeoutMs,
    speechProxyEnabled: globalRelay.speechProxyEnabled,
    speechServiceUrl: globalRelay.speechServiceUrl
  };
}

function firstRouteLevelRabiLinkRelayConfig(): RabiLinkRelayGlobalConfig | null {
  const globalConfig = rabiGlobalConfig.read();
  for (const definition of readConfig().gateways) {
    if (!definition.rabiLinkRelayUrl?.trim() && !definition.rabiLinkRelayToken?.trim()) continue;
    const url = definition.rabiLinkRelayUrl?.trim() || "";
    const token = definition.rabiLinkRelayToken?.trim() || "";
    return {
      enabled: Boolean(url && token),
      url,
      token,
      deviceId: definition.rabiLinkRelayDeviceId?.trim() || globalConfig.rabiLinkRelay.deviceId || globalConfig.rabiName || definition.id,
      claimWaitMs: definition.rabiLinkRelayClaimWaitMs ?? globalConfig.rabiLinkRelay.claimWaitMs,
      replyIdleTimeoutMs: definition.rabiLinkRelayReplyIdleTimeoutMs ?? globalConfig.rabiLinkRelay.replyIdleTimeoutMs,
      speechProxyEnabled: globalConfig.rabiLinkRelay.speechProxyEnabled,
      speechServiceUrl: globalConfig.rabiLinkRelay.speechServiceUrl
    };
  }
  return null;
}

function rabiLinkRelayConfigForMeta(): RabiLinkRelayGlobalConfig {
  const globalRelay = rabiGlobalConfig.read().rabiLinkRelay;
  if (hasGlobalRabiLinkRelayConfig(globalRelay)) return globalRelay;
  return firstRouteLevelRabiLinkRelayConfig() || globalRelay;
}

function syncRabiLinkRelayRuntime(): void {
  if (!managerShouldAutostart) {
    personaSyncLanServer.stop();
    rabiLinkRelayRuntime.stop();
    return;
  }
  const globalConfig = rabiGlobalConfig.read();
  const relay = rabiLinkRelayConfigForMeta();
  const lanEnabled = relay.enabled && Boolean(relay.url.trim()) && Boolean(relay.token.trim());
  if (!lanEnabled) personaSyncLanServer.stop();
  rabiLinkRelayRuntime.sync({
    ...relay,
    deviceGuid: globalConfig.rabiGuid,
    deviceName: globalConfig.rabiName || os.hostname(),
    localWebguiUrl: `http://127.0.0.1:${managerPort}`,
    peerUrls: lanEnabled ? personaSyncLanServer.peerUrls() : [],
    speechProxyEnabled: relay.speechProxyEnabled,
    localSpeechUrl: relay.speechServiceUrl
  });
  if (lanEnabled && personaSyncLanServer.status().state !== "listening") {
    void personaSyncLanServer.start()
      .then(() => syncRabiLinkRelayRuntime())
      .catch(error => console.warn(`Persona sync LAN listener unavailable; Relay fallback remains active: ${error instanceof Error ? error.message : String(error)}`));
  }
}

function writeAdapterConfigFile(definition: GatewayDefinition): void {
  const configName = sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName;
  const configPath = adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(adapterConfigItem(definition), null, 2), "utf8");
}

function backfillNapcatInstanceWebuiToken(definition: GatewayDefinition, instanceId: string, token: unknown): string | null {
  const value = String(token || "").trim();
  if (!value) return null;
  const instances = normalizeNapCatInstances(definition);
  const target = instances.find((item) => item.id === instanceId);
  if (!target) return null;
  let changed = false;
  if (target.webuiToken !== value) {
    target.webuiToken = value;
    changed = true;
  }
  if (target.accessToken === value) {
    target.accessToken = "";
    changed = true;
  }
  if (!changed) return null;
  definition.napcatInstances = instances;
  const primary = instances.find((item) => item.enabled !== false) ?? instances[0];
  if (primary) {
    definition.napcatAccessToken = primary.accessToken ?? "";
    definition.napcatWebuiToken = primary.webuiToken ?? "";
  }
  writeAdapterConfigFile(definition);
  return value;
}

function backfillNapcatInstanceWebuiUrl(definition: GatewayDefinition, instanceId: string, webuiUrl: unknown): string | null {
  const value = String(webuiUrl || "").trim();
  if (!value) return null;
  const instances = normalizeNapCatInstances(definition);
  const target = instances.find((item) => item.id === instanceId);
  if (!target || target.webuiUrl === value) return null;
  target.webuiUrl = value;
  definition.napcatInstances = instances;
  const primary = instances.find((item) => item.enabled !== false) ?? instances[0];
  if (primary) {
    definition.napcatWebuiUrl = primary.webuiUrl;
    definition.napcatWebuiToken = primary.webuiToken ?? "";
  }
  writeAdapterConfigFile(definition);
  return value;
}

function correctedNapcatWebuiUrlFromHealth(health: Record<string, unknown>): string {
  const webui = (health.webui ?? {}) as Record<string, unknown>;
  return String(webui.correctedUrl || webui.correctedWebuiUrl || "").trim();
}

function addHealthDiagnostic(health: Record<string, unknown>, message: string): Record<string, unknown> {
  const diagnostics = Array.isArray(health.diagnostics) ? health.diagnostics : [];
  return {
    ...health,
    diagnostics: [
      ...diagnostics,
      message
    ]
  };
}

function napcatInstanceIgnoreKeys(instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text) keys.add(`${prefix}:${text}`);
  };
  add("id", instance.id);
  add("ws", instance.gatewayPort);
  add("http", instance.httpUrl);
  add("webui", instance.webuiUrl);
  add("qq", instance.botUserId);
  return [...keys];
}

function ignoreNapcatInstance(definition: GatewayDefinition, instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): void {
  const next = new Set(normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds));
  for (const key of napcatInstanceIgnoreKeys(instance)) next.add(key);
  definition.ignoredNapcatInstanceIds = [...next];
}

async function addManagedNapcatInstance(request: NapcatAddRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  if (!gatewayId) throw new Error("缺少 gatewayId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const definition = runtime.definition;
  const instances = normalizeNapCatInstances(definition);
  const index = instances.length + 1;
  const usedIds = new Set(instances.map((item) => item.id));
  let id = sanitizeInstanceId(`napcat-${index}`, `napcat-${index}`);
  let idSuffix = index + 1;
  while (usedIds.has(id)) {
    id = sanitizeInstanceId(`napcat-${idSuffix}`, `napcat-${idSuffix}`);
    idSuffix += 1;
  }
  const used = new Set<number>();
  for (const runtimeItem of runtimes.values()) {
    for (const item of normalizeNapCatInstances(runtimeItem.definition)) {
      used.add(Number(item.gatewayPort || 0));
      try { used.add(Number(new URL(item.httpUrl).port || 0)); } catch { /* ignore */ }
      try { used.add(Number(new URL(item.webuiUrl || "").port || 0)); } catch { /* ignore */ }
    }
  }

  const steps = ["正在准备 NapCat 实例...", "正在查找合适端口..."];
  const webuiPort = await nextFreeLocalPort(6099 + instances.length, used);
  const httpPort = await nextFreeLocalPort(3000 + instances.length, used);
  const wsPort = await nextFreeLocalPort(Number(definition.gatewayPort || 8789) + instances.length, used);
  steps.push(`已分配端口：WebUI ${webuiPort} / HTTP ${httpPort} / WS ${wsPort}`);

  const prepared = prepareManagedNapcatInstance(napcatManagerCtx(), {
    id,
    name: `QQ ${index}`,
    gatewayPort: wsPort,
    httpPort,
    webuiPort,
    index
  });
  const instance = prepared.instance;
  steps.push(...prepared.steps);

  definition.napcatInstances = [...instances, instance];
  const primary = definition.napcatInstances.find((item) => item.enabled !== false) ?? instance;
  definition.gatewayPort = primary.gatewayPort;
  definition.napcatHttpUrl = primary.httpUrl;
  definition.napcatWebuiUrl = primary.webuiUrl;
  definition.napcatAccessToken = primary.accessToken ?? "";
  definition.napcatWebuiToken = primary.webuiToken ?? "";
  writeAdapterConfigFile(definition);
  loadRuntimes();

  steps.push("正在执行启动命令...");
  const launchResult = await launchNapcatInstanceEndpoint(napcatManagerCtx(), { gatewayId, instanceId: id });
  steps.push(String(launchResult.message || "已尝试启动 NapCat 后台。"));
  return {
    ok: launchResult.ok !== false,
    message: launchResult.ok !== false
      ? "已创建并启动 NapCat，请在自动打开的 WebUI 中登录 QQ。"
      : "已创建 NapCat 实例，但后台未在超时时间内可达；请检查启动命令或手动打开 WebUI。",
    steps,
    launch: launchResult,
    instance,
    webuiUrl: instance.webuiUrl,
    loginUrl: prepared.loginUrl || instance.webuiUrl
  };
}

async function removeManagedNapcatInstance(request: NapcatRemoveRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) throw new Error("缺少 gatewayId 或 instanceId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const instances = normalizeNapCatInstances(runtime.definition);
  const existing = instances.find((item) => item.id === instanceId);
  ignoreNapcatInstance(runtime.definition, {
    ...(existing || {}),
    id: instanceId,
    gatewayPort: request.gatewayPort ?? existing?.gatewayPort,
    httpUrl: request.httpUrl ?? existing?.httpUrl,
    webuiUrl: request.webuiUrl ?? existing?.webuiUrl,
    botUserId: request.botUserId
  });
  const stop = await stopNapcatInstanceEndpoint(napcatManagerCtx(), {
    gatewayId,
    instanceId,
    name: request.name,
    gatewayPort: request.gatewayPort,
    httpUrl: request.httpUrl,
    webuiUrl: request.webuiUrl,
    accessToken: request.accessToken,
    webuiToken: request.webuiToken,
    launchCommand: request.launchCommand,
    workingDir: request.workingDir
  });
  if (!existing) {
    writeAdapterConfigFile(runtime.definition);
    loadRuntimes();
    return {
      ok: true,
      message: "已关闭并忽略扫描发现的 NapCat 实例。",
      stop
    };
  }
  runtime.definition.napcatInstances = instances.filter((item) => item.id !== instanceId);
  const primary = runtime.definition.napcatInstances.find((item) => item.enabled !== false);
  if (primary) {
    runtime.definition.gatewayPort = primary.gatewayPort;
    runtime.definition.napcatHttpUrl = primary.httpUrl;
    runtime.definition.napcatWebuiUrl = primary.webuiUrl;
    runtime.definition.napcatAccessToken = primary.accessToken ?? "";
    runtime.definition.napcatWebuiToken = primary.webuiToken ?? "";
  } else {
    runtime.definition.messageAdaptersDisabled = [...new Set([...(runtime.definition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
    runtime.definition.messageAdapterPolicies = {
      ...(runtime.definition.messageAdapterPolicies ?? {}),
      napcat: {
        ...(runtime.definition.messageAdapterPolicies?.napcat ?? {}),
        inputEnabled: false
      }
    };
    runtime.definition.napcatAccessToken = "";
    runtime.definition.napcatWebuiToken = "";
  }
  writeAdapterConfigFile(runtime.definition);
  loadRuntimes();
  return {
    ok: true,
    message: "已停止并移除 NapCat 实例。",
    stop
  };
}

function readRoleMessageConfigShared(roleId: string | undefined): Partial<GatewayDefinition> {
  return configRepository.readRoleMessageConfig(roleId) as Partial<GatewayDefinition>;
}

function readRoleMessageConfigItem(roleId: string | undefined, _configName: string): Partial<GatewayDefinition> {
  return readRoleMessageConfigShared(roleId);
}

function writePersonaConfigFile(roleId: string, items: GatewayDefinition[]): void {
  // Persona fields have one owner even when several Routes bind the same persona.
  const source = items.find(item => Array.isArray(item.notificationRules) && item.notificationRules.length > 0) ?? items[0];
  configRepository.writePersonaConfig(roleId, {
    automationRules: source?.automationRules,
    notificationRules: source?.notificationRules,
    recentMessageLimits: source?.recentMessageLimits,
    speechTriggerKeywords: source?.speechTriggerKeywords,
    languageStyle: source?.languageStyle
  });
}

function ensurePersonaConfigFile(roleId: string): string {
  const configPath = personaConfigPath(roleId);
  if (!fs.existsSync(configPath)) {
    const safeRoleId = sanitizeRoleId(roleId);
    configRepository.writePersonaConfig(safeRoleId, { notificationRules: [] });
  }

  return configPath;
}

function openFileWithDefaultApp(filePath: string): void {
  const target = path.resolve(filePath);
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "explorer", target];
  } else if (platform === "darwin") {
    command = "open";
    args = [target];
  } else {
    command = "xdg-open";
    args = [target];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function openConfigFilePayload(type: string | null, gatewayId: string | null, roleId: string | null): Record<string, unknown> {
  if (type === "manager") {
    ensureDataDirs();
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  if (type === "role" || type === "persona") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开 persona.md。");
    }
    const roleFileName = runtime?.definition.agentRoleFile ?? "persona.md";
    const rolePath = roleFilePath(rolesRoot, safeRoleId, roleFileName);
    if (!fs.existsSync(rolePath)) {
      fs.mkdirSync(path.dirname(rolePath), { recursive: true });
      fs.writeFileSync(rolePath, "", "utf8");
    }
    openFileWithDefaultApp(rolePath);
    return { code: 0, data: { path: rolePath } };
  }

  if (type === "role-folder") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开人格文件夹。");
    }
    const roleDirectory = path.join(rolesRoot, safeRoleId);
    fs.mkdirSync(roleDirectory, { recursive: true });
    openFileWithDefaultApp(roleDirectory);
    return { code: 0, data: { path: roleDirectory } };
  }

  if (type === "role-message-config") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开 personaConfig.json。");
    }
    const configPath = ensurePersonaConfigFile(safeRoleId);
    openFileWithDefaultApp(configPath);
    return { code: 0, data: { path: configPath } };
  }

  if (type !== "routes" && type !== "route-folder") {
    throw new Error(`Unsupported config file type: ${type || ""}`);
  }

  if (!gatewayId) {
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  const runtime = runtimes.get(gatewayId);
  if (!runtime) {
    // fallback: open routeRoot if runtime not found (e.g. unsaved configName change)
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  const configName = sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
  const configPath = adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    writeAdapterConfigFile(runtime.definition);
  }
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openFileWithDefaultApp(targetPath);
  return { code: 0, data: { path: targetPath } };
}

function loadRuntimes(): void {
  const config = readConfig();
  const seen = new Set<string>();

  for (const rawDefinition of config.gateways) {
    const definition = normalizeDefinition(rawDefinition);
    seen.add(definition.id);
    const existing = runtimes.get(definition.id);
    if (existing) {
      if (definitionFingerprint(existing.definition) !== definitionFingerprint(definition)) {
        existing.needsRestart = true;
      }
      existing.definition = definition;
      continue;
    }

    runtimes.set(definition.id, {
      definition,
      process: null,
      needsRestart: false,
      startedAt: null,
      stoppedAt: null,
      lastExit: null,
      log: []
    });
  }

  for (const id of [...runtimes.keys()]) {
    if (!seen.has(id)) {
      const runtime = runtimes.get(id);
      if (runtime?.process) {
        runtime.process.kill();
      }
      runtimes.delete(id);
    }
  }
  memoryConsolidationScheduler?.reschedule();
  reconcileMessageProcessingAgentRequests();
}

function syncRunningGateways(): void {
  for (const runtime of runtimes.values()) {
    const action = gatewayRuntimeSyncAction({
      managerShouldAutostart,
      enabled: runtime.definition.enabled === true,
      running: Boolean(runtime.process),
      needsRestart: runtime.needsRestart
    });
    if (action === "restart") {
      appendLog(runtime, "restarting because gateway config changed");
      runtime.process?.kill();
      continue;
    }
    if (action === "start") {
      startGateway(runtime.definition.id);
    }
    if (action === "stop") {
      stopGateway(runtime.definition.id);
    }
  }
}

function reloadChangedConfig(reason: string): void {
  try {
    personaCatalog.invalidate(rolesRoot);
    loadRuntimes();
    syncRunningGateways();
    console.log(`gateway-manager reloaded ${reason}`);
  } catch (error) {
    console.error(`Failed to reload gateway config ${reason}`, error);
  }
}

type ConfigWatcher = { close(): void };

function startConfigWatcher(): ConfigWatcher {
  const watchers = new Map<string, { watcher: fs.FSWatcher; signature: string }>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let initialized = false;
  let refreshInFlight = false;

  const armDirectories = (files: string[]): void => {
    const rules = configWatchDirectoryRules(routeRoot, rolesRoot, files);
    for (const [directory, entry] of watchers) {
      if (rules.has(directory)) continue;
      entry.watcher.close();
      watchers.delete(directory);
    }
    for (const [directory, rule] of rules) {
      if (closed) continue;
      const signature = `${rule.discovery}|${[...rule.fileNames].sort().join("|")}`;
      const existing = watchers.get(directory);
      if (existing?.signature === signature) continue;
      existing?.watcher.close();
      try {
        const watcher = fs.watch(directory, (eventType, fileName) => {
          if (!configWatchEventMatches(rule, eventType, fileName)) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (closed) return;
            void refreshSnapshot("after config file event");
          }, 120);
        });
        watcher.on("error", error => console.warn(`Config watch failed for ${directory}:`, error));
        watchers.set(directory, { watcher, signature });
      } catch (error) {
        console.warn(`Unable to watch config directory ${directory}:`, error);
      }
    }
  };

  const refreshSnapshot = async (reason: string): Promise<void> => {
    if (closed || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const discovered = await collectWatchedConfigFiles({
        routeRoot,
        rolesRoot,
        timeoutMs: 1500,
        adapterConfigPath,
        personaConfigPath,
        includeDirectory: name => Boolean(sanitizeRoleId(name))
      });
      const snapshot = await configFilesSnapshot(discovered.files, 1500);
      const partialErrors = [...discovered.errors, ...snapshot.errors];
      if (partialErrors.length) {
        console.warn(`Config watch snapshot is partial (${partialErrors.length} unavailable path(s)); Manager remains online.`);
      }
      if (initialized && snapshot.snapshot !== watchedConfigSnapshot) {
        watchedConfigSnapshot = snapshot.snapshot;
        reloadChangedConfig(reason);
      } else {
        watchedConfigSnapshot = snapshot.snapshot;
        initialized = true;
      }
      armDirectories(discovered.files);
    } catch (error) {
      console.warn("Config watch refresh failed; Manager remains online.", error);
    } finally {
      refreshInFlight = false;
    }
  };
  void refreshSnapshot("during config watch initialization");
  return {
    close(): void {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const entry of watchers.values()) entry.watcher.close();
      watchers.clear();
    }
  };
}

function appendLog(runtime: GatewayRuntime, line: string): void {
  runtimes.appendLog(runtime, line);
  console.log(`[${runtime.definition.id}] ${line}`);
}

function childCommand(extraArgs: string[] = []) {
  return resolveGatewayChildCommand(rootDir, extraArgs);
}

function reconcileSpeechMicrophone(reason: string): void {
  void speechRuntimeControl.start()
    .then(() => speechControl.reconcileMicrophone())
    .catch(error => {
      console.warn(
        `Speech runtime/microphone reconciliation failed after ${reason}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
}

function resolveWingetCopilot(): string | null {
  if (!process.env.LOCALAPPDATA) return null;
  const wingetBase = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of fs.readdirSync(wingetBase)) {
      if (entry.startsWith("GitHub.Copilot")) {
        const exe = path.join(wingetBase, entry, "copilot.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* skip */ }
  return null;
}

function envFor(definition: GatewayDefinition): NodeJS.ProcessEnv {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  const routeDataDir = path.relative(rootDir, routeFolderPath(routeRoot, configName)).replace(/\\/g, "/");
  const routeRolesDir = path.relative(rootDir, rolesRoot).replace(/\\/g, "/");
  const activeAdapters = sharedGatewayAdapterTypes(definition);
  const runtimeAdapters = activeAdapters.length > 0 ? activeAdapters : ["disabled" as MessageAdapterType];
  const rabiLinkRelay = rabiLinkRelayConfigFor(definition);
  const globalConfig = rabiGlobalConfig.read();
  return {
    ...process.env,
    GATEWAY_ID: definition.id,
    RABI_GUID: globalConfig.rabiGuid,
    GATEWAY_MANAGER_PORT: String(managerPort),
    GATEWAY_MANAGER_URL: `http://127.0.0.1:${managerPort}`,
    PERSONA_MESSAGING_CAPABILITY: currentPersonaMessageAuthority().issue(definition.id, roleIdForDefinition(definition)),
    MESSAGE_ADAPTER_TYPE: runtimeAdapters[0] ?? "napcat",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(runtimeAdapters),
    MESSAGE_ADAPTER_POLICIES: JSON.stringify(definition.messageAdapterPolicies ?? {}),
    AGENT_MODEL: definition.agentModel?.trim() || "",
    AGENT_REASONING_EFFORT: definition.agentReasoningEffort ?? "",
    MESSAGE_PROCESSING_AGENTS: JSON.stringify(definition.messageProcessingAgents ?? {}),
    PIPELINE_PRESET: definition.pipelinePreset ?? "",
    PIPELINE: definition.pipeline ? JSON.stringify(definition.pipeline) : "",
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。",
    HEARTBEAT_SKIP_WHEN_AGENT_BUSY: definition.heartbeatSkipWhenAgentBusy ? "1" : "0",
    PERSONA_AUTOMATION_SCRIPTS_ENABLED: definition.personaAutomationScriptsEnabled ? "1" : "0",
    REMOTE_AGENT_DEFAULT_DEVICE_ID: definition.remoteAgentDefaultDeviceId?.trim() || "",
    REMOTE_AGENT_DEFAULT_CWD: configPathValue(definition.remoteAgentDefaultCwd) || "",
    REMOTE_AGENT_DEFAULT_THREAD_NAME: definition.remoteAgentDefaultThreadName?.trim() || "",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_WEBUI_URL: definition.napcatWebuiUrl ?? process.env.NAPCAT_WEBUI_URL ?? "http://127.0.0.1:6099/webui",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    NAPCAT_WEBUI_TOKEN: definition.napcatWebuiToken ?? process.env.NAPCAT_WEBUI_TOKEN ?? "",
    NAPCAT_INSTANCES: JSON.stringify(definition.napcatInstances ?? normalizeNapCatInstances(definition)),
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
    FENNENOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNENOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    FENNOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    XIAOAI_WEBHOOK_PORT: String(definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    XIAOAI_WEBHOOK_PATH: definition.xiaoaiWebhookPath ?? "/xiaoai",
    RABILINK_WEBHOOK_PORT: String(definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    RABILINK_WEBHOOK_PATH: definition.rabiLinkWebhookPath ?? "/rabilink",
    RABILINK_WEBHOOK_HOST: definition.rabiLinkWebhookHost?.trim() || "0.0.0.0",
    RABILINK_RELAY_ENABLED: rabiLinkRelay.url && rabiLinkRelay.token ? "1" : "",
    RABILINK_RELAY_URL: rabiLinkRelay.url,
    RABILINK_RELAY_APP_TOKEN: rabiLinkRelay.token,
    RABILINK_RELAY_DEVICE_ID: rabiLinkRelay.deviceId || definition.id,
    RABILINK_RELAY_DEVICE_GUID: globalConfig.rabiGuid,
    RABILINK_RELAY_CLAIM_WAIT_MS: String(rabiLinkRelay.claimWaitMs),
    RABILINK_RELAY_REPLY_IDLE_TIMEOUT_MS: String(rabiLinkRelay.replyIdleTimeoutMs),
    WECOM_BOT_ID: definition.wecomBotId?.trim() || process.env.WECOM_BOT_ID || "",
    WECOM_BOT_SECRET: definition.wecomBotSecret?.trim() || process.env.WECOM_BOT_SECRET || "",
    WECOM_WS_URL: definition.wecomWsUrl?.trim() || process.env.WECOM_WS_URL || "",
    WEIXIN_BASE_URL: definition.weixinBaseUrl?.trim() || process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com",
    WEIXIN_BOT_TYPE: definition.weixinBotType?.trim() || process.env.WEIXIN_BOT_TYPE || "3",
    FEISHU_APP_ID: definition.feishuAppId?.trim() || process.env.FEISHU_APP_ID || "",
    FEISHU_APP_SECRET: definition.feishuAppSecret?.trim() || process.env.FEISHU_APP_SECRET || "",
    FEISHU_VERIFICATION_TOKEN: definition.feishuVerificationToken?.trim() || process.env.FEISHU_VERIFICATION_TOKEN || "",
    FEISHU_ENCRYPT_KEY: definition.feishuEncryptKey?.trim() || process.env.FEISHU_ENCRYPT_KEY || "",
    FEISHU_EVENT_SUBSCRIPTION_ENABLED: definition.feishuEventSubscriptionEnabled === true ? "true" : "false",
    FEISHU_WEBHOOK_PORT: String(definition.feishuWebhookPort ?? definition.gatewayPort),
    FEISHU_WEBHOOK_PATH: definition.feishuWebhookPath ?? "/feishu",
    CODEX_THREAD_ID: definition.primaryAgentAdapter === "dsh"
      ? (definition.dshSessionId?.trim() || definition.codexThreadId?.trim() || "")
      : (definition.codexThreadId?.trim() || ""),
    CODEX_THREAD_NAME: resolveCodexThreadName(definition),
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? normalizeCodexCwd(process.env.CODEX_CWD) ?? rootDir,
    DSH_SESSION_ID: definition.dshSessionId?.trim() || "",
    DSH_SESSION_NAME: definition.dshSessionName?.trim() || "",
    DSH_BASE_URL: definition.dshBaseUrl?.trim() || "",
    DSH_CWD: normalizeCodexCwd(definition.dshCwd) || "",
    CODEX_PLAN_ASSISTANT_ENABLED: definition.codexPlanAssistantEnabled === true ? "true" : "false",
    CODEX_PLAN_ASSISTANT_MODEL: normalizeCodexPlanAssistantModel(definition.codexPlanAssistantModel),
    CODEX_PLAN_ASSISTANT_SESSIONS: JSON.stringify(definition.codexPlanAssistantSessions ?? []),
    CODEX_MEMORY_CONSOLIDATION_AGENT_ENABLED: definition.codexMemoryConsolidationAgentEnabled === true ? "true" : "false",
    CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL: normalizeCodexMemoryConsolidationAgentModel(definition.codexMemoryConsolidationAgentModel),
    COPILOT_THREAD_NAME: resolveCopilotThreadName(definition),
    COPILOT_CLI_BIN: definition.copilotCliBin?.trim() || process.env.COPILOT_CLI_BIN || resolveWingetCopilot() || (process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "copilot.cmd") : "") || "copilot",
    COPILOT_CWD: resolvePersistedProjectPath(definition.copilotCwd, rootDir) ?? resolveProjectPath(process.env.COPILOT_CWD, rootDir) ?? rootDir,
    MARVIS_APP_ID: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
    ASTRBOT_URL: definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185",
    ASTRBOT_USERNAME: definition.astrbotUsername?.trim() || process.env.ASTRBOT_USERNAME || "",
    ASTRBOT_PASSWORD: definition.astrbotPassword?.trim() || process.env.ASTRBOT_PASSWORD || "",
    ASTRBOT_PROJECT_ID: definition.astrbotProjectId?.trim() || process.env.ASTRBOT_PROJECT_ID || "",
    ASTRBOT_SESSION_ID: definition.astrbotSessionId?.trim() || process.env.ASTRBOT_SESSION_ID || "",
    ROLES_DIR: routeRolesDir,
    AGENT_ROLE_ID: sanitizeRoleId(definition.agentRoleId),
    AGENT_ROLE_FILE: definition.agentRoleFile ?? "persona.md",
    AGENT_ADAPTERS: Array.isArray(definition.agentAdapters) ? definition.agentAdapters.join(",") : process.env.AGENT_ADAPTERS ?? "",
    PRIMARY_AGENT_ADAPTER: definition.primaryAgentAdapter ?? "",
    TARGET_GROUP_ID: definition.targetGroupId ?? "",
    BOT_NICKNAME: process.env.BOT_NICKNAME ?? "QQ小助手",
    ROUTE_VARIABLES: definition.routeVariables ? JSON.stringify(definition.routeVariables) : "",
    ROUTE_PROFILES: Array.isArray(definition.routeProfiles) ? JSON.stringify(definition.routeProfiles) : "",
    DATA_DIR: routeDataDir,
    GROUP_NOTIFICATION_TEMPLATE: definition.groupNotificationTemplate ?? "",
    GROUP_AT_NOTIFICATION_TEMPLATE: definition.groupAtNotificationTemplate ?? "",
    GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupDirectReplyNotificationTemplate ?? definition.groupReplyNotificationTemplate ?? "",
    GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupIndirectReplyNotificationTemplate ?? definition.groupNicknameNotificationTemplate ?? "",
    PRIVATE_NOTIFICATION_TEMPLATE: definition.privateNotificationTemplate ?? "",
    VOICE_TRANSCRIPT_NOTIFICATION_TEMPLATE: definition.voiceTranscriptNotificationTemplate ?? "",
    RECENT_MESSAGE_LIMITS: definition.recentMessageLimits ? JSON.stringify(definition.recentMessageLimits) : "",
    SPEECH_PUSH_MODE: definition.speechPushMode ?? "hot",
    SPEECH_TRIGGER_KEYWORDS: Array.isArray(definition.speechTriggerKeywords) ? JSON.stringify(definition.speechTriggerKeywords) : "[]",
    AUTOMATION_RULES: Array.isArray(definition.automationRules) ? JSON.stringify(definition.automationRules) : "[]",
    NOTIFICATION_RULES: Array.isArray(definition.notificationRules) ? JSON.stringify(definition.notificationRules) : "",
  };
}

function startGateway(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.definition.enabled) {
    appendLog(runtime, "skip start because gateway is disabled");
    return;
  }
  if (runtime.process && !runtime.process.killed) {
    return;
  }

  const command = childCommand();
  const agentStateGeneration = randomUUID();
  const childEnv = envFor(runtime.definition);
  childEnv.AGENT_STATE_GENERATION = agentStateGeneration;
  runtime.agentStateGeneration = agentStateGeneration;
  agentStateByGateway.delete(runtime.definition.id);
  const child = spawn(command.command, command.args, {
    cwd: rootDir,
    env: childEnv,
    shell: command.shell,
    windowsHide: true
  });

  runtime.log = [];
  runtime.process = child;
  runtime.needsRestart = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = null;
  appendLog(runtime, `started pid=${child.pid ?? "unknown"} port=${runtime.definition.gatewayPort}`);
  managerOperationalLog.record("info", "gateway_started", {
    routeId: runtime.definition.id,
    childPid: child.pid,
    result: "started"
  });

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, line);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, `ERR ${line}`);
    }
  });

  child.on("exit", (code, signal) => {
    runtime.process = null;
    runtime.agentStateGeneration = undefined;
    agentStateByGateway.delete(runtime.definition.id);
    runtime.stoppedAt = new Date().toISOString();
    runtime.lastExit = {
      code,
      signal,
      at: runtime.stoppedAt
    };
    appendLog(runtime, `exited code=${code ?? ""} signal=${signal ?? ""}`);
    managerOperationalLog.record(code === 0 ? "info" : "warn", "gateway_exited", {
      routeId: runtime.definition.id,
      childPid: child.pid,
      result: `code=${code ?? "null"}; signal=${signal ?? "null"}`
    });
    if (runtime.needsRestart && runtime.definition.enabled) {
      startGateway(runtime.definition.id);
    }
  });
}

function stopGateway(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.process) {
    return;
  }

  appendLog(runtime, "stopping");
  managerOperationalLog.record("info", "gateway_stop_requested", {
    routeId: runtime.definition.id,
    childPid: runtime.process.pid,
    result: "requested"
  });
  runtime.agentStateGeneration = undefined;
  agentStateByGateway.delete(runtime.definition.id);
  runtime.process.kill();
}

function stopAllGateways(): void {
  for (const runtime of runtimes.values()) {
    runtime.needsRestart = false;
    if (runtime.process) {
      appendLog(runtime, "stopping because manager is shutting down");
      runtime.agentStateGeneration = undefined;
      agentStateByGateway.delete(runtime.definition.id);
      runtime.process.kill();
    }
  }
}

function dataDirFor(definition: GatewayDefinition): string {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  return routeFolderPath(routeRoot, configName);
}

function roleInfoFor(
  definition: GatewayDefinition,
  includeContents = true,
  catalogCache?: Map<string, Array<Record<string, unknown>>>
): Record<string, unknown> {
  return roleInfoPayload(rootDir, definition, { includeContents, catalogCache, personaCatalog });
}

function readAgentStates(definition: GatewayDefinition): Record<string, unknown> {
  const adapters = definition.agentAdapters ?? ["codex"];
  const states: Record<string, unknown> = {};
  for (const adapter of adapters) {
    states[adapter] = readAgentState(definition, adapter);
  }
  return states;
}

function readAgentState(definition: GatewayDefinition, adapterType: AgentAdapterType): Record<string, unknown> {
  const reported: Record<string, unknown> = agentStateByGateway.get(definition.id)?.[adapterType] ?? {};
  const base = defaultAgentState(definition, adapterType);
  if (adapterType === "codex") {
    return resolveCodexRuntimeState(base, reported);
  }
  const merged: Record<string, unknown> = {
    ...base,
    ...reported,
    agentAdapterType: adapterType
  };
  return {
    ...merged,
    bound: adapterType === "marvis"
      ? false
      : Boolean(merged.lastNotificationAt && !merged.lastNotificationError)
  };
}

function defaultAgentState(definition: GatewayDefinition, adapterType: AgentAdapterType): Record<string, unknown> {
  if (adapterType === "copilotCli") {
    return {
      agentAdapterType: adapterType,
      bound: false,
      monitorThreadName: resolveCopilotThreadName(definition),
      monitorThreadSource: definition.copilotCliBin || process.env.COPILOT_CLI_BIN || "copilot",
      monitorProjectPath: definition.copilotCwd || rootDir,
      message: "Copilot CLI 已配置；等待当前 Manager 进程收到成功投递上报。"
    };
  }

  if (adapterType === "marvis") {
    return {
      agentAdapterType: adapterType,
      bound: false,
      handoffOnly: true,
      monitorThreadName: "Marvis",
      monitorThreadSource: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
      message: "Marvis 当前是打开桌面端并复制 prompt 的人工接力，不做线程绑定。"
    };
  }

  if (adapterType === "astrbot") {
    const astrbotUrl = definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185";
    return {
      agentAdapterType: adapterType,
      bound: false,
      monitorThreadName: "AstrBot Agent",
      monitorThreadSource: astrbotUrl,
      message: "AstrBot 已配置；等待当前 Manager 进程收到成功投递上报。"
    };
  }

  if (adapterType === "dsh") {
    const dshBaseUrl = definition.dshBaseUrl?.trim() || "http://127.0.0.1:3080";
    return {
      agentAdapterType: adapterType,
      bound: Boolean(definition.dshSessionId?.trim() && definition.dshCwd?.trim()),
      monitorThreadName: definition.dshSessionName?.trim() || "DSH 主人格",
      monitorThreadSource: dshBaseUrl,
      monitorThreadId: definition.dshSessionId?.trim() || "",
      monitorThreadCwd: definition.dshCwd?.trim() || "",
      deliveryTransport: "http",
      message: "DSH 会话主人格：投递通过 DSH apiproxy session.prompt 完成。"
    };
  }

  return {
    agentAdapterType: adapterType,
    bound: false,
    monitorThreadName: resolveCodexThreadName(definition),
    monitorProjectPath: normalizeCodexCwd(definition.codexCwd) ?? rootDir,
    deliveryTransport: "desktop-ipc",
    desktopHostName: "Codex/ChatGPT Desktop",
    desktopHostRequired: true,
    message: "等待 Codex Desktop 首次接收投递；Desktop 未就绪时不会启动备用 Runtime。"
  };
}

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function checkHttpEndpoint(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeAdapterTypes(definition: GatewayDefinition): MessageAdapterType[] {
  const active = sharedGatewayAdapterTypes(definition);
  return active.length > 0 ? active : ["disabled"];
}

function adapterRuntimes(type: MessageAdapterType): GatewayRuntime[] {
  return [...runtimes.values()].filter((runtime) => runtimeAdapterTypes(runtime.definition).includes(type));
}

function firstLocalIpv4Address(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const match = (addresses ?? []).find((address) => address.family === "IPv4" && !address.internal);
    if (match?.address) return match.address;
  }
  return "127.0.0.1";
}

function isUnspecifiedHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function callbackUrlForCopy(url: string, type: MessageAdapterType): string {
  if (type !== "rabilink") return url;
  try {
    const parsed = new URL(url);
    if (isUnspecifiedHttpHost(parsed.hostname)) {
      parsed.hostname = firstLocalIpv4Address();
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function routeCallbackEndpoint(runtime: GatewayRuntime, type: MessageAdapterType): AdapterEndpoint | null {
  if (type !== "webhook" && type !== "fennenote" && type !== "xiaoai" && type !== "rabilink") return null;
  const definition = runtime.definition;
  const status = readGatewayStatus(definition) as Record<string, any>;
  const callback = status.httpCallbacks?.[type];
  const port = type === "fennenote"
    ? definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
      : type === "rabilink"
        ? definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
        : definition.webhookPort ?? definition.gatewayPort;
  const pathValue = type === "fennenote"
    ? definition.fenneNoteWebhookPath ?? "/fennenote"
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPath ?? "/xiaoai"
      : type === "rabilink"
        ? definition.rabiLinkWebhookPath ?? "/rabilink"
        : definition.webhookPath ?? "/webhook";
  const normalized = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const host = type === "rabilink" ? definition.rabiLinkWebhookHost?.trim() || "0.0.0.0" : "127.0.0.1";
  const url = callbackUrlForCopy(String(callback?.url || `http://${host}:${port}${normalized}`), type);
  return {
    label: `${sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName} 回调入口`,
    url,
    healthy: Boolean(runtime.process && callback)
  };
}

function routeHasRecentMessages(runtime: GatewayRuntime, type: MessageAdapterType): boolean {
  try {
    const files = readMessageFiles(runtime.definition) as Record<string, { entries?: unknown[] }>;
    return Boolean(files[type]?.entries?.length);
  } catch {
    return false;
  }
}

function napcatManagerCtx() {
  return {
    rootDir,
    getRuntimes: () => [...runtimes.values()].map((runtime) => ({
      ...runtime,
      status: readGatewayStatus(runtime.definition) as Record<string, unknown>
    })),
    normalizeNapCatInstances,
    appendLog,
    checkHttpEndpoint
  };
}

function agentManagerApiCtx(): AgentManagerApiContext {
  return {
    rootDir,
    getRuntimes: () => runtimes.values(),
    checkHttpEndpoint,
    resolveWingetCopilot
  };
}

function repairGatewayConfigsForScan(_targetGatewayId?: string): { changed: boolean; messages: string[] } {
  const original = readConfig().gateways;
  const messages: string[] = [];
  const managedNapcatRoot = path.resolve(rootDir, "data", "napcat");
  const normalized = original.map((definition) => {
    if (!definitionUsesNapcat(definition) && Array.isArray(definition.napcatInstances) && definition.napcatInstances.length > 0) {
      messages.push(`已移除 ${definition.id} 中残留的 NapCat 实例配置。`);
    }
    const cleanedDefinition = { ...definition };
    if (Array.isArray(cleanedDefinition.napcatInstances)) {
      const kept = cleanedDefinition.napcatInstances.filter((instance) => {
        const workingDir = instance.workingDir?.trim();
        if (!workingDir) return true;
        const resolved = path.resolve(workingDir);
        const relative = path.relative(managedNapcatRoot, resolved);
        const isManaged = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
        const keep = !isManaged || fs.existsSync(resolved);
        if (!keep) {
          messages.push(`已移除 ${definition.id}/${instance.id} 中已删除的受管 NapCat 实例配置。`);
        }
        return keep;
      });
      cleanedDefinition.napcatInstances = kept;
      if ((definition.napcatInstances?.length ?? 0) > 0 && kept.length === 0) {
        cleanedDefinition.messageAdaptersDisabled = [...new Set([...(cleanedDefinition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
        cleanedDefinition.messageAdapterPolicies = {
          ...(cleanedDefinition.messageAdapterPolicies ?? {}),
          napcat: {
            ...(cleanedDefinition.messageAdapterPolicies?.napcat ?? {}),
            inputEnabled: false
          }
        };
      }
    }
    return normalizeDefinition(cleanedDefinition);
  });
  sharedAutoAssignGatewayPorts(normalized, managerPort);
  sharedValidateGatewayPortConflicts(normalized);

  const byId = new Map(original.map((definition) => [definition.id, definition]));
  for (const repaired of normalized) {
    const before = byId.get(repaired.id);
    if (!before) {
      messages.push(`已补齐路由 ${repaired.id} 的标准配置。`);
      continue;
    }
    if (before.gatewayPort !== repaired.gatewayPort) {
      messages.push(`已为 ${repaired.id} 重新分配入口端口：${before.gatewayPort} -> ${repaired.gatewayPort}。`);
    }
    if (before.webhookPort !== repaired.webhookPort && repaired.webhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 Webhook 端口：${before.webhookPort || "-"} -> ${repaired.webhookPort}。`);
    }
    if (before.fenneNoteWebhookPort !== repaired.fenneNoteWebhookPort && repaired.fenneNoteWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 FenneNote 端口：${before.fenneNoteWebhookPort || "-"} -> ${repaired.fenneNoteWebhookPort}。`);
    }
    if (before.xiaoaiWebhookPort !== repaired.xiaoaiWebhookPort && repaired.xiaoaiWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 XiaoAI 端口：${before.xiaoaiWebhookPort || "-"} -> ${repaired.xiaoaiWebhookPort}。`);
    }
    if (definitionUsesNapcat(repaired)) {
      const beforeInstances = before.napcatInstances ?? [];
      const repairedInstances = repaired.napcatInstances ?? [];
      for (const instance of repairedInstances) {
        const old = beforeInstances.find((item) => item.id === instance.id);
        if (!old) continue;
        if (old.gatewayPort !== instance.gatewayPort) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 WS 端口：${old.gatewayPort} -> ${instance.gatewayPort}。`);
        }
        if (old.httpUrl !== instance.httpUrl) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 HTTP 地址：${old.httpUrl || "-"} -> ${instance.httpUrl}。`);
        }
      }
    }
  }

  const changed = messages.length > 0;
  if (changed) {
    writeConfig({ gateways: normalized });
    loadRuntimes();
    syncRunningGateways();
  }
  return { changed, messages };
}

const MESSAGE_ADAPTER_SCAN_DEADLINE_MS = 6_000;
const NAPCAT_HEALTH_SCAN_DEADLINE_MS = 6_500;

function messageAdapterScanFallback(
  type: Exclude<MessageAdapterType, "disabled">,
  label: string,
  maturity: AgentMaturity,
  diagnostic: ScanDiagnostic
): MessageAdapterScanResult {
  return {
    type,
    label,
    maturity,
    installed: false,
    scan: diagnostic,
    warnings: [
      diagnostic.state === "timeout"
        ? `${label} 检查超过本轮 ${MESSAGE_ADAPTER_SCAN_DEADLINE_MS} ms 截止时间；没有把超时推断为离线。`
        : `${label} 检查失败：${diagnostic.message || "未知错误"}`
    ]
  };
}

type MessageAdapterScanBundle = {
  adapters: Record<Exclude<MessageAdapterType, "disabled">, MessageAdapterScanResult>;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
};

async function messageAdapterScanPayload(): Promise<MessageAdapterScanBundle> {
  const webhookLikeScanCtx = {
    rootDir,
    adapterRuntimes,
    routeCallbackEndpoint,
    routeHasRecentMessages,
    checkHttpEndpoint,
    fenneNotePlaybackUrl
  };
  const bounded = await runBoundedScans([
    {
      key: "napcat",
      run: () => scanNapcatEndpoint(napcatManagerCtx()),
      fallback: (diagnostic) => messageAdapterScanFallback("napcat", "NapCat / OneBot", "verified", diagnostic)
    },
    {
      key: "fennenote",
      run: () => scanFenneNoteEndpoint(webhookLikeScanCtx),
      fallback: (diagnostic) => messageAdapterScanFallback("fennenote", "FenneNote / 芬妮笔记", "experimental", diagnostic)
    },
    {
      key: "xiaoai",
      run: () => scanXiaoAiEndpoint(webhookLikeScanCtx),
      fallback: (diagnostic) => messageAdapterScanFallback("xiaoai", "小米音箱 / 小爱", "experimental", diagnostic)
    },
    {
      key: "rabilink",
      run: () => scanRabiLinkEndpoint(webhookLikeScanCtx),
      fallback: (diagnostic) => messageAdapterScanFallback("rabilink", "RabiLink / Relay 直连", "experimental", diagnostic)
    },
    {
      key: "wearable",
      run: () => scanWearableEndpoint(webhookLikeScanCtx),
      fallback: (diagnostic) => messageAdapterScanFallback("wearable", "智能手表/手环", "experimental", diagnostic)
    },
    {
      key: "webhook",
      run: () => scanWebhookEndpoint(webhookLikeScanCtx),
      fallback: (diagnostic) => messageAdapterScanFallback("webhook", "通用 Webhook", "experimental", diagnostic)
    },
    {
      key: "wecom",
      run: () => scanWeComEndpoint({
        rootDir,
        adapterRuntimes,
        routeHasRecentMessages
      }),
      fallback: (diagnostic) => messageAdapterScanFallback("wecom", "企业微信 / WeCom", "experimental", diagnostic)
    },
    {
      key: "speech",
      run: async (): Promise<MessageAdapterScanResult> => {
        const speechStatus = await speechControl.status();
        return {
          type: "speech",
          label: "语音消息端",
          maturity: "verified",
          installed: speechStatus.state === "online",
          endpoints: [{ label: "RabiSpeech 本机服务", url: speechStatus.configuredUrl, healthy: speechStatus.state === "online" }],
          requirements: [
            { id: "builtin", label: "RabiPC 内置语音消息端", required: true, ok: true, detail: "麦克风、阈值、常驻转录和 Route 投递由 RabiPC 提供。" },
            { id: "runtime", label: "RabiSpeech 本地模型服务", required: true, ok: speechStatus.state === "online", detail: speechStatus.error || `${speechStatus.providers.tts.length} 个 TTS provider，${speechStatus.providers.asr.length} 个 ASR provider。` },
            { id: "provider-mode", label: "语音 Provider 模式", required: true, ok: true, detail: speechStatus.localOnly === true ? "当前仅启用本地 TTS/ASR Provider。" : "已显式启用 API Provider；密钥由 RabiSpeech 进程环境持有。" }
          ],
          warnings: speechStatus.state === "online" ? [] : ["先启动 RabiSpeech，再做麦克风实机 ASR 和 TTS 排队播放测试。"]
        };
      },
      fallback: (diagnostic) => messageAdapterScanFallback("speech", "语音消息端", "verified", diagnostic)
    }
  ] as const, { deadlineMs: MESSAGE_ADAPTER_SCAN_DEADLINE_MS });
  const { napcat, fennenote, xiaoai, rabilink, wearable, webhook, wecom, speech } = bounded.values;
  const weixinRuntimes = adapterRuntimes("weixin");
  const feishuRuntimes = adapterRuntimes("feishu");
  const weixinStatuses = weixinRuntimes.map(runtime => {
    const status = readGatewayStatus(runtime.definition) as Record<string, any>;
    return status.messageAdapters?.weixin ?? {};
  });
  const weixinLoggedIn = weixinStatuses.some(status => status.loggedIn === true && status.sessionPhase === "restored");
  const weixinRestoring = weixinStatuses.some(status => status.sessionPhase === "restoring");
  const weixinCredentialsRetained = weixinStatuses.some(status =>
    status.credentialsRetained === true
    && (status.sessionPhase === "restoring" || status.sessionPhase === "temporarily_unreachable"));
  const weixinLoginDetail = weixinLoggedIn
    ? "当前个人微信会话已由服务端确认并完成恢复。"
    : weixinRestoring
      ? "正在从安全存储恢复会话；这不影响 Manager 或其它消息入口。"
      : weixinCredentialsRetained
        ? "外部 API 暂时不可达，但会话凭据仍保留，不要求扫码。"
        : "当前没有可用会话；请明确点击生成二维码后扫码。";
  const weixinHasRecentMessages = weixinRuntimes.some((runtime) => routeHasRecentMessages(runtime, "weixin"));

  const adapters: Record<Exclude<MessageAdapterType, "disabled">, MessageAdapterScanResult> = {
    napcat,
    remoteAgent: remoteAgentHub.localScanResult(),
    heartbeat: {
      type: "heartbeat",
      label: "定时触发",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "route", label: "RabiRoute 内部定时器", required: true, ok: true, detail: "无需额外安装。" },
        { id: "agent", label: "Agent 端可接收消息", required: true, ok: undefined, detail: "保存后用“立即触发”或日志页验证投递。" }
      ],
      warnings: ["定时触发不会证明外部平台可用，只能验证路由到 Agent 的链路。"]
    },
    rolePanel: {
      type: "rolePanel",
      label: "角色面板",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "builtin", label: "RabiRoute 内置角色面板", required: true, ok: true, detail: "无需安装；托盘打开后可作为本地消息端使用。" },
        { id: "timeline", label: "角色聊天记录", required: true, ok: true, detail: "按角色写入 data/roles/<RoleId>/role-panel/messages.jsonl。" }
      ],
      warnings: ["角色面板是固定内置消息端，不能删除或禁用；自由聊天使用 role_panel_message 路由类型。"]
    },
    speech,
    fennenote,
    xiaoai,
    rabilink,
    wearable,
    wecom,
    weixin: {
      type: "weixin",
      label: "个人微信 / Weixin",
      maturity: "experimental",
      installed: true,
      endpoints: [{ label: "OpenClaw iLink API", url: weixinRuntimes[0]?.definition.weixinBaseUrl || process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com", healthy: weixinLoggedIn }],
      requirements: [
        { id: "route", label: "已配置个人微信消息端", required: true, ok: weixinRuntimes.length > 0, detail: weixinRuntimes.length > 0 ? "已存在使用 weixin adapter 的 Route。" : "在 Route 中启用个人微信消息端。" },
        { id: "login", label: "个人微信当前会话", required: true, ok: weixinLoggedIn, detail: weixinLoginDetail },
        { id: "recent-message", label: "历史个人微信消息证据", required: false, ok: weixinHasRecentMessages, detail: weixinHasRecentMessages ? "存在历史消息记录；它不代表当前登录。" : "尚无历史消息记录；它与当前登录状态相互独立。" }
      ],
      warnings: [
        "个人微信接入仍是实验能力，依赖 OpenClaw iLink API；单入口故障不会升级为 Manager 或 QQ 全局故障。",
        "二维码只在管理面明确请求后生成；临时网络失败会保留安全会话，不要求重新扫码。"
      ]
    },
    feishu: {
      type: "feishu",
      label: "飞书 / Feishu",
      maturity: "experimental",
      installed: feishuRuntimes.length > 0,
      requirements: [
        { id: "route", label: "已配置飞书消息端", required: true, ok: feishuRuntimes.length > 0, detail: feishuRuntimes.length > 0 ? "Route 已启用独立 feishu adapter。" : "在 Route 中启用 feishu adapter。" },
        { id: "app", label: "飞书应用凭据", required: true, ok: feishuRuntimes.some((runtime) => Boolean(runtime.definition.feishuAppId && runtime.definition.feishuAppSecret)), detail: "需要 App ID 和 App Secret，群机器人 webhook 不能替代。" },
        { id: "event", label: "事件订阅与签名", required: true, ok: feishuRuntimes.some((runtime) => runtime.definition.feishuEventSubscriptionEnabled === true && Boolean(runtime.definition.feishuVerificationToken && runtime.definition.feishuEncryptKey)), detail: "需要配置公网 HTTPS 回调、Verification Token、Encrypt Key，订阅 im.message.receive_v1 后再显式确认。" }
      ],
      warnings: ["飞书是独立消息端；通用 webhook 不会作为飞书入站或出站替代。"]
    },
    webhook
  };
  for (const [type, diagnostic] of Object.entries(bounded.diagnostics)) {
    const adapter = adapters[type as Exclude<MessageAdapterType, "disabled">];
    if (adapter) adapter.scan = diagnostic;
  }
  return {
    adapters,
    diagnostics: bounded.diagnostics,
    partial: bounded.partial,
    durationMs: bounded.durationMs,
    deadlineMs: bounded.deadlineMs
  };
}

async function napcatScanHealthPayload(): Promise<{
  payload: NapcatHealthScanPayload;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
}> {
  const ctx = napcatManagerCtx();
  const napcatRuntimes = [...runtimes.values()].filter((runtime) => definitionUsesNapcat(runtime.definition));
  return scanNapcatHealthReadOnly({
    runtimes: napcatRuntimes,
    gatewayId: (runtime) => runtime.definition.id,
    instances: (runtime) => runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition),
    instanceId: (instance) => instance.id,
    instanceEnabled: (instance) => instance.enabled !== false,
    instanceMetadata: (instance) => ({
      gatewayPort: instance.gatewayPort,
      instanceName: instance.name || instance.id,
      webui: {
        url: instance.webuiUrl,
        configuredUrl: instance.webuiUrl
      }
    }),
    testHealth: (runtime, instance) => testNapcatHealthEndpoint(ctx, {
        gatewayId: runtime.definition.id,
        instanceId: instance.id,
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        accessToken: instance.accessToken,
        webuiToken: instance.webuiToken,
        gatewayPort: instance.gatewayPort,
        botUserId: (instance as NapCatInstanceDefinition & { botUserId?: string | number }).botUserId,
        botNickname: (instance as NapCatInstanceDefinition & { botNickname?: string }).botNickname,
        readWebuiLoginInfo: true,
        inspectProcesses: false
      }) as Promise<Record<string, unknown>>
  }, { deadlineMs: NAPCAT_HEALTH_SCAN_DEADLINE_MS });
}

type NapcatHealthRequest = {
  gatewayId?: string;
  instanceId?: string;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  gatewayPort?: number;
  readWebuiLoginInfo?: boolean;
  botUserId?: string | number;
  botNickname?: string;
};

type NapcatAddRequest = {
  gatewayId?: string;
};

type NapcatRemoveRequest = {
  gatewayId?: string;
  instanceId?: string;
  name?: string;
  gatewayPort?: number;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botUserId?: string | number;
  botNickname?: string;
};

type NapcatLaunchRequest = {
  gatewayId?: string;
  instanceId?: string;
  forceRestart?: boolean;
  visible?: boolean;
};
function readGatewayStatus(definition: GatewayDefinition): Record<string, unknown> {
  const statusPath = path.join(dataDirFor(definition), "gateway-status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      statusPath,
      napcat: {
        connected: false
      }
    };
  }

  try {
    return {
      ...JSON.parse(fs.readFileSync(statusPath, "utf8")) as Record<string, unknown>,
      statusPath
    };
  } catch (error) {
    return {
      statusPath,
      napcat: {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function napcatStatusRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, item] of Object.entries(value)) {
      if (isRecord(item)) {
        rows.push({
          id,
          ...item
        });
      }
    }
    return rows;
  }
  return [];
}

function collectStartedNapcatInstances(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const runtime of runtimes.values()) {
    if (!runtime.process || !definitionUsesNapcat(runtime.definition)) {
      continue;
    }

    const configName = sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
    const configuredInstances = runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition);
    const status = readGatewayStatus(runtime.definition);
    const statusInstances = napcatStatusRows(status.napcatInstances);
    const sourceRows = statusInstances.length > 0
      ? statusInstances
      : napcatStatusRows(status.napcat ? { default: status.napcat } : {});

    for (const row of sourceRows) {
      const rowId = String(row.id || row.instanceId || "default");
      const rowPort = Number(row.gatewayPort || row.port || row.wsPort || 0);
      const configured = configuredInstances.find((instance) =>
        String(instance.id) === rowId || (rowPort > 0 && Number(instance.gatewayPort) === rowPort)
      );
      if (!configured) {
        continue;
      }
      const gatewayPort = Number(row.gatewayPort || configured?.gatewayPort || runtime.definition.gatewayPort || 0);
      const key = [
        runtime.definition.id,
        rowId,
        gatewayPort || "",
        row.httpUrl || configured?.httpUrl || ""
      ].join(":");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        ...configured,
        ...row,
        id: rowId,
        name: row.name || configured?.name || rowId,
        enabled: configured?.enabled !== false,
        gatewayPort,
        httpUrl: row.httpUrl || configured?.httpUrl || runtime.definition.napcatHttpUrl,
        webuiUrl: row.webuiUrl || configured?.webuiUrl || runtime.definition.napcatWebuiUrl,
        routeId: runtime.definition.id,
        routeName: runtime.definition.name || runtime.definition.routeName || configName,
        configName,
        started: true,
        running: true
      });
    }
  }

  return rows;
}

function gatewayStatusForRuntime(runtime: GatewayRuntime, startedNapcatInstances = collectStartedNapcatInstances()): Record<string, unknown> {
  const status = readGatewayStatus(runtime.definition);
  return {
    ...status,
    napcatInstances: startedNapcatInstances,
    napcatInstanceCount: startedNapcatInstances.length,
    napcatStartedInstanceCount: startedNapcatInstances.length
  };
}

function messageFileCandidateDirs(definition: GatewayDefinition): string[] {
  const dirs = new Set<string>();
  dirs.add(dataDirFor(definition));
  const roleId = sanitizeRoleId(definition.agentRoleId);
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  if (roleId) {
    dirs.add(roleFolderPath(rolesDir, roleId));
  }
  for (const profile of definition.routeProfiles ?? []) {
    if (profile.dataDir) {
      dirs.add(path.resolve(rootDir, profile.dataDir));
    }
    const profileRole = sanitizeRoleId(profile.agentRoleId);
    if (profileRole) {
      dirs.add(roleFolderPath(rolesDir, profileRole));
    }
  }
  return [...dirs];
}

function recordTimeMs(record: Record<string, unknown>): number {
  const time = record.time;
  if (typeof time === "number") {
    return time < 10_000_000_000 ? time * 1000 : time;
  }
  for (const key of ["recordedAt", "createdAt", "lastEventAt", "startedAt", "endedAt"]) {
    const value = record[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function messageFileEntry(source: string, filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const groupId = record.groupId ?? record.group_id;
  const userId = record.userId ?? record.user_id;
  const text = record.rawMessage ?? record.message ?? record.text ?? record.content ?? record.rawLine ?? "";
  return {
    source,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: record.messageId ?? record.message_id,
    instanceId: record.instanceId,
    adapterType: record.adapterType,
    sender: record.senderName ?? record.sender ?? record.source,
    target: groupId ? `群 ${String(groupId)}` : userId ? `私聊 ${String(userId)}` : record.source ?? source,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

type WearableAlertCliDelivery = {
  status: "delivered" | "routed" | "missed" | "failed" | "skipped";
  matchedRuleCount: number;
  sentPacketCount: number;
  reason?: string;
  adapterOutcomes?: Array<{
    adapter?: string;
    status?: string;
    error?: string;
  }>;
};

type WearableGatewayDeliveryResult = WearableAlertCliDelivery & {
  gatewayId?: string;
};

const wearableDeliveryResultPrefix = "RABIROUTE_WEARABLE_DELIVERY_RESULT:";

function wearableGatewayRuntimes(roleId: string): GatewayRuntime[] {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) return [];
  return [...runtimes.values()].filter((runtime) => {
    const definitionRoleId = sanitizeRoleId(runtime.definition.agentRoleId)
      || routeRuntimeParts(runtime.definition.id).roleId;
    return runtime.definition.enabled !== false
      && definitionRoleId === safeRoleId
      && sharedGatewayAdapterTypes(runtime.definition).includes("wearable");
  });
}

function parseWearableAlertCliDelivery(stdout: string): WearableAlertCliDelivery | null {
  const line = stdout.split(/\r?\n/)
    .reverse()
    .find((item) => item.startsWith(wearableDeliveryResultPrefix));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(wearableDeliveryResultPrefix.length)) as Partial<WearableAlertCliDelivery>;
    if (!parsed.status || !Number.isFinite(parsed.matchedRuleCount) || !Number.isFinite(parsed.sentPacketCount)) {
      return null;
    }
    return {
      status: parsed.status,
      matchedRuleCount: Number(parsed.matchedRuleCount),
      sentPacketCount: Number(parsed.sentPacketCount),
      reason: parsed.reason,
      adapterOutcomes: Array.isArray(parsed.adapterOutcomes) ? parsed.adapterOutcomes : []
    };
  } catch {
    return null;
  }
}

function deliverWearableAlertViaGateway(
  runtime: GatewayRuntime,
  alert: WearableHealthAlert,
  context: WearableHealthAlertDeliveryContext
): Promise<WearableGatewayDeliveryResult> {
  return new Promise((resolve) => {
    const command = childCommand(["--wearable-health-alert-stdin"]);
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    let stdout = "";
    let settled = false;
    const finish = (result: WearableGatewayDeliveryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      appendLog(
        runtime,
        `wearable alert delivery status=${result.status} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`
      );
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        gatewayId: runtime.definition.id,
        status: "failed",
        matchedRuleCount: 0,
        sentPacketCount: 0,
        reason: "delivery_process_timeout"
      });
    }, 10 * 60 * 1000);
    child.stdout.on("data", (data) => {
      if (stdout.length < 256 * 1024) stdout += data.toString();
    });
    child.stderr.resume();
    child.on("error", () => finish({
      gatewayId: runtime.definition.id,
      status: "failed",
      matchedRuleCount: 0,
      sentPacketCount: 0,
      reason: "delivery_process_spawn_failed"
    }));
    child.on("exit", () => {
      const delivery = parseWearableAlertCliDelivery(stdout);
      finish(delivery
        ? { gatewayId: runtime.definition.id, ...delivery }
        : {
            gatewayId: runtime.definition.id,
            status: "failed",
            matchedRuleCount: 0,
            sentPacketCount: 0,
            reason: "delivery_process_no_result"
          });
    });
    child.stdin.on("error", () => {
      // The process exit/error handlers own the final result.
    });
    child.stdin.end(JSON.stringify({ alert, context }));
  });
}

async function deliverWearableAlert(
  roleId: string,
  alert: WearableHealthAlert,
  context: WearableHealthAlertDeliveryContext
): Promise<WearableGatewayDeliveryResult[]> {
  const candidates = wearableGatewayRuntimes(roleId);
  if (candidates.length === 0) {
    return [{
      status: "missed",
      matchedRuleCount: 0,
      sentPacketCount: 0,
      reason: "no_matching_wearable_gateway"
    }];
  }
  return Promise.all(candidates.map((runtime) => deliverWearableAlertViaGateway(runtime, alert, context)));
}

function wearableHealthMessageFileEntry(filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const metric = String(record.metric ?? "");
  const value = record.value;
  const sleepState = String(record.sleepState ?? record.stage ?? "");
  const text = metric === "heart_rate"
    ? `心率 ${String(value ?? "-")} bpm`
    : metric === "sleep_state"
      ? `睡眠状态 ${sleepState || "unknown"}`
      : metric === "sleep_session"
        ? `睡眠区间 ${String(record.startAt ?? "-")} ~ ${String(record.endAt ?? "-")}`
        : metric === "sleep_stage"
          ? `睡眠阶段 ${sleepState || "unknown"}`
          : `健康观测 ${metric || "unknown"}`;
  return {
    source: "智能手表 / 手环",
    path: filePath,
    time: record.recordedAt,
    timeMs: recordTimeMs(record),
    messageId: record.id,
    adapterType: "wearable",
    sender: record.sourceDeviceName ?? record.sourceDeviceId ?? "wearable",
    target: "健康时间线",
    text,
    raw: record
  };
}

function adapterLogEntry(filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const text = record.message ?? data.text ?? data.rawMessage ?? data.eventType ?? record.rawLine ?? "";
  return {
    adapter: record.adapter,
    event: record.event ?? "log",
    level: record.level ?? "info",
    instanceId: record.instanceId,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: data.messageId ?? data.message_id,
    sender: data.senderName ?? data.sender ?? data.source,
    target: data.groupId ? `群 ${String(data.groupId)}` : data.userId ? `私聊 ${String(data.userId)}` : data.path ?? data.name,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

type JsonlTailCache = Map<string, Array<Record<string, unknown>>>;

function cachedJsonlTail(
  cache: JsonlTailCache | undefined,
  filePath: string,
  limit: number
): Array<Record<string, unknown>> {
  if (!cache) return readJsonlTail(filePath, limit);
  const key = `${filePath}\0${limit}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const records = readJsonlTail(filePath, limit);
  cache.set(key, records);
  return records;
}

function readMessageFiles(
  definition: GatewayDefinition,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const dirs = messageFileCandidateDirs(definition);
  const readEntries = (source: string, fileName: string) => dirs.flatMap((dir) => {
    const filePath = path.join(dir, fileName);
    return cachedJsonlTail(tailCache, filePath, 8).map((record) => messageFileEntry(source, filePath, record));
  });
  const sortTail = (items: Array<Record<string, unknown>>) => items
    .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
    .slice(-8)
    .reverse();

  const napcatEntries = sortTail([
    ...readEntries("群聊", "group-messages.jsonl"),
    ...readEntries("私聊", "private-messages.jsonl")
  ]);
  const heartbeatEntries = sortTail(readEntries("定时触发", "heartbeat-events.jsonl"));
  const rolePanelEntries = sortTail(dirs.flatMap((dir) => {
    const filePath = path.join(dir, "role-panel", "messages.jsonl");
    return cachedJsonlTail(tailCache, filePath, 8).map((record) => messageFileEntry("角色面板", filePath, record));
  }));
  const speechEntries = sortTail([
    ...readEntries("语音消息端", "speech-voice-transcripts.jsonl"),
    ...readEntries("语音消息端", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "speech")
  ]);
  const fenneNoteEntries = sortTail([
    ...readEntries("FenneNote / 芬妮笔记", "fennenote-voice-transcripts.jsonl"),
    ...readEntries("FenneNote / 芬妮笔记", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "fennenote")
  ]);
  const xiaoaiEntries = sortTail([
    ...readEntries("小米音箱 / 小爱", "xiaoai-voice-transcripts.jsonl"),
    ...readEntries("小米音箱 / 小爱", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "xiaoai")
  ]);
  const rabiLinkEntries = sortTail([
    ...readEntries("RabiLink / Relay", "rabilink-voice-transcripts.jsonl"),
    ...readEntries("RabiLink / Relay", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "rabilink")
  ]);
  const wearableHealthFiles = dirs.flatMap((dir) => {
    const eventsDir = path.join(dir, "wearable-health", "events");
    try {
      return fs.readdirSync(eventsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/i.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, 7)
        .map((entry) => path.join(eventsDir, entry.name));
    } catch {
      return [];
    }
  });
  const wearableEntries = sortTail(wearableHealthFiles.flatMap((filePath) =>
    cachedJsonlTail(tailCache, filePath, 8).map((record) => wearableHealthMessageFileEntry(filePath, record))));
  const webhookEntries = sortTail(readEntries("通用 Webhook", "voice-transcripts.jsonl")
    .filter((entry) => {
      const adapterType = String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase();
      return !adapterType || adapterType === "webhook";
    }));
  const wecomEntries = sortTail(readEntries("企业微信 / WeCom", "wecom-messages.jsonl"));
  const weixinEntries = sortTail(readEntries("个人微信 / Weixin", "weixin-messages.jsonl"));

  return {
    napcat: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "group-messages.jsonl"),
        path.join(dir, "private-messages.jsonl")
      ]),
      entries: napcatEntries
    },
    heartbeat: {
      paths: dirs.map((dir) => path.join(dir, "heartbeat-events.jsonl")),
      entries: heartbeatEntries
    },
    rolePanel: {
      paths: dirs.map((dir) => path.join(dir, "role-panel", "messages.jsonl")),
      entries: rolePanelEntries
    },
    speech: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "speech-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: speechEntries
    },
    fennenote: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "fennenote-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: fenneNoteEntries
    },
    xiaoai: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "xiaoai-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: xiaoaiEntries
    },
    rabilink: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "rabilink-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: rabiLinkEntries
    },
    wearable: {
      paths: wearableHealthFiles,
      entries: wearableEntries
    },
    wecom: {
      paths: dirs.map((dir) => path.join(dir, "wecom-messages.jsonl")),
      entries: wecomEntries
    },
    weixin: {
      paths: dirs.map((dir) => path.join(dir, "weixin-messages.jsonl")),
      entries: weixinEntries
    },
    webhook: {
      paths: dirs.map((dir) => path.join(dir, "voice-transcripts.jsonl")),
      entries: webhookEntries
    }
  };
}

function readAdapterLogs(
  definition: GatewayDefinition,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const dir = dataDirFor(definition);
  const readEntries = (adapter: MessageAdapterType | "outbox") => {
    const filePath = path.join(dir, `${adapter}-adapter.log.jsonl`);
    return cachedJsonlTail(tailCache, filePath, 12)
      .map((record) => adapterLogEntry(filePath, record))
      .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
      .reverse();
  };

  return {
    napcat: {
      paths: [path.join(dir, "napcat-adapter.log.jsonl")],
      entries: readEntries("napcat")
    },
    heartbeat: {
      paths: [path.join(dir, "heartbeat-adapter.log.jsonl")],
      entries: readEntries("heartbeat")
    },
    rolePanel: {
      paths: [path.join(dir, "rolePanel-adapter.log.jsonl")],
      entries: readEntries("rolePanel")
    },
    speech: {
      paths: [path.join(dir, "speech-adapter.log.jsonl")],
      entries: readEntries("speech")
    },
    fennenote: {
      paths: [path.join(dir, "fennenote-adapter.log.jsonl")],
      entries: readEntries("fennenote")
    },
    xiaoai: {
      paths: [path.join(dir, "xiaoai-adapter.log.jsonl")],
      entries: readEntries("xiaoai")
    },
    rabilink: {
      paths: [path.join(dir, "rabilink-adapter.log.jsonl")],
      entries: readEntries("rabilink")
    },
    wearable: {
      paths: [path.join(dir, "wearable-adapter.log.jsonl")],
      entries: readEntries("wearable")
    },
    wecom: {
      paths: [path.join(dir, "wecom-adapter.log.jsonl")],
      entries: readEntries("wecom")
    },
    weixin: {
      paths: [path.join(dir, "weixin-adapter.log.jsonl")],
      entries: readEntries("weixin")
    },
    webhook: {
      paths: [path.join(dir, "webhook-adapter.log.jsonl")],
      entries: readEntries("webhook")
    },
    outbox: {
      paths: [path.join(dir, "outbox-adapter.log.jsonl")],
      entries: readEntries("outbox")
    }
  };
}

function runtimeStatus(runtime: GatewayRuntime): Record<string, unknown> {
  return runtimeStatusWithRoleInfoCache(runtime);
}

function runtimeStatusWithRoleInfoCache(
  runtime: GatewayRuntime,
  roleInfoCatalogCache?: Map<string, Array<Record<string, unknown>>>,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const usesNapcat = definitionUsesNapcat(runtime.definition);
  const gatewayStatus = gatewayStatusForRuntime(runtime);
  const rabiLinkRelay = rabiLinkRelayConfigFor(runtime.definition);
  return {
    id: runtime.definition.id,
    name: runtime.definition.name,
    configName: sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName,
    enabled: runtime.definition.enabled,
    messageAdapterType: runtime.definition.messageAdapterType ?? "napcat",
    messageAdapters: runtime.definition.messageAdapters ?? [runtime.definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: runtime.definition.messageAdaptersDisabled ?? [],
    messageInputsDisabled: runtime.definition.messageInputsDisabled === true,
    messageAdapterPolicies: runtime.definition.messageAdapterPolicies ?? {},
    agentAdapters: runtime.definition.agentAdapters ?? ["codex"],
    primaryAgentAdapter: runtime.definition.primaryAgentAdapter,
    messageProcessingAgents: runtime.definition.messageProcessingAgents ?? {},
    pipelinePreset: runtime.definition.pipelinePreset,
    pipeline: runtime.definition.pipeline,
    gatewayPort: runtime.definition.gatewayPort,
    webhookPort: runtime.definition.webhookPort,
    webhookPath: runtime.definition.webhookPath,
    fenneNoteWebhookPort: runtime.definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: runtime.definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: runtime.definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: runtime.definition.xiaoaiWebhookPath,
    rabiLinkWebhookPort: runtime.definition.rabiLinkWebhookPort,
    rabiLinkWebhookPath: runtime.definition.rabiLinkWebhookPath,
    rabiLinkWebhookHost: runtime.definition.rabiLinkWebhookHost,
    rabiLinkRelayEnabled: rabiLinkRelay.enabled,
    rabiLinkRelayUrl: rabiLinkRelay.url,
    rabiLinkRelayToken: rabiLinkRelay.token ? "********" : "",
    rabiLinkRelayDeviceId: rabiLinkRelay.deviceId,
    rabiLinkRelayClaimWaitMs: rabiLinkRelay.claimWaitMs,
    rabiLinkRelayReplyIdleTimeoutMs: rabiLinkRelay.replyIdleTimeoutMs,
    rabiLinkRelayConfigScope: hasGlobalRabiLinkRelayConfig() ? "global" : "route-fallback",
    wecomBotId: runtime.definition.wecomBotId,
    wecomBotSecret: runtime.definition.wecomBotSecret,
    wecomWsUrl: runtime.definition.wecomWsUrl,
    feishuAppId: runtime.definition.feishuAppId ? "********" : "",
    feishuAppSecret: runtime.definition.feishuAppSecret ? "********" : "",
    feishuVerificationToken: runtime.definition.feishuVerificationToken ? "********" : "",
    feishuEncryptKey: runtime.definition.feishuEncryptKey ? "********" : "",
    feishuEventSubscriptionEnabled: runtime.definition.feishuEventSubscriptionEnabled === true,
    feishuWebhookPort: runtime.definition.feishuWebhookPort,
    feishuWebhookPath: runtime.definition.feishuWebhookPath,
    weixinBaseUrl: runtime.definition.weixinBaseUrl,
    weixinBotType: runtime.definition.weixinBotType,
    heartbeatIntervalSeconds: runtime.definition.heartbeatIntervalSeconds ?? 900,
    heartbeatMessage: runtime.definition.heartbeatMessage ?? "",
    personaAutomationScriptsEnabled: runtime.definition.personaAutomationScriptsEnabled === true,
    remoteAgentDefaultDeviceId: runtime.definition.remoteAgentDefaultDeviceId ?? "",
    remoteAgentDefaultCwd: runtime.definition.remoteAgentDefaultCwd ?? "",
    remoteAgentDefaultThreadName: runtime.definition.remoteAgentDefaultThreadName ?? "",
    napcatHttpUrl: runtime.definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
    napcatWebuiUrl: runtime.definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
    napcatAccessToken: runtime.definition.napcatAccessToken ?? "",
    napcatWebuiToken: runtime.definition.napcatWebuiToken ?? "",
    napcatInstances: usesNapcat ? (runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)) : [],
    targetGroupId: runtime.definition.targetGroupId ?? "",
    routeVariables: runtime.definition.routeVariables,
    routeName: runtime.definition.routeName,
    routeProfiles: runtime.definition.routeProfiles ?? [],
    agentModel: runtime.definition.agentModel ?? "",
    agentReasoningEffort: runtime.definition.agentReasoningEffort,
    codexThreadId: runtime.definition.codexThreadId,
    codexThreadName: resolveCodexThreadName(runtime.definition),
    codexCwd: runtime.definition.codexCwd,
    codexPlanAssistantEnabled: runtime.definition.codexPlanAssistantEnabled === true,
    codexPlanAssistantModel: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel),
    codexPlanAssistantSessions: runtime.definition.codexPlanAssistantSessions ?? [],
    codexMemoryConsolidationAgentEnabled: runtime.definition.codexMemoryConsolidationAgentEnabled === true,
    codexMemoryConsolidationAgentModel: normalizeCodexMemoryConsolidationAgentModel(runtime.definition.codexMemoryConsolidationAgentModel),
    codexHooks: normalizeCodexHookSettings(runtime.definition.codexHooks),
    copilotThreadName: resolveCopilotThreadName(runtime.definition),
    copilotCwd: runtime.definition.copilotCwd,
    copilotCliBin: runtime.definition.copilotCliBin,
    marvisAppId: runtime.definition.marvisAppId,
    astrbotUrl: runtime.definition.astrbotUrl,
    astrbotUsername: runtime.definition.astrbotUsername,
    astrbotPassword: runtime.definition.astrbotPassword,
    astrbotProjectId: runtime.definition.astrbotProjectId,
    astrbotSessionId: runtime.definition.astrbotSessionId,
    rolesDir: runtime.definition.rolesDir,
    routesDir: runtime.definition.routesDir,
    agentRoleId: runtime.definition.agentRoleId,
    agentRoleFile: runtime.definition.agentRoleFile,
    roleInfo: roleInfoFor(runtime.definition, true, roleInfoCatalogCache),
    dataDir: runtime.definition.dataDir,
    groupNotificationTemplate: runtime.definition.groupNotificationTemplate,
    groupAtNotificationTemplate: runtime.definition.groupAtNotificationTemplate,
    groupDirectReplyNotificationTemplate: runtime.definition.groupDirectReplyNotificationTemplate,
    groupIndirectReplyNotificationTemplate: runtime.definition.groupIndirectReplyNotificationTemplate,
    groupReplyNotificationTemplate: runtime.definition.groupReplyNotificationTemplate,
    groupNicknameNotificationTemplate: runtime.definition.groupNicknameNotificationTemplate,
    privateNotificationTemplate: runtime.definition.privateNotificationTemplate,
    notificationRules: runtime.definition.notificationRules,
    automationRules: runtime.definition.automationRules,
    roleNotificationRules: runtime.definition.roleNotificationRules,
    roleRouteNames: runtime.definition.roleRouteNames,
    running: Boolean(runtime.process),
    pid: runtime.process?.pid ?? null,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastExit: runtime.lastExit,
    gatewayStatus,
    adapterLogs: readAdapterLogs(runtime.definition, tailCache),
    messageFiles: readMessageFiles(runtime.definition, tailCache),
    agentStates: readAgentStates(runtime.definition),
    log: runtime.log.slice(-30)
  };
}

function runtimeSummaryStatus(runtime: GatewayRuntime): Record<string, unknown> {
  return runtimeSummaryStatusWithRoleInfoCache(runtime);
}

function runtimeSummaryStatusWithRoleInfoCache(
  runtime: GatewayRuntime,
  roleInfoCatalogCache?: Map<string, Array<Record<string, unknown>>>
): Record<string, unknown> {
  const definition = runtime.definition;
  const usesNapcat = definitionUsesNapcat(definition);
  const napcatInstances = usesNapcat
    ? (definition.napcatInstances ?? normalizeNapCatInstances(definition)).map((instance) => ({
      id: instance.id,
      name: instance.name,
      enabled: instance.enabled,
      botNickname: instance.botNickname
    }))
    : [];
  return {
    id: definition.id,
    name: definition.name,
    configName: sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName,
    routeName: definition.routeName,
    enabled: definition.enabled,
    running: Boolean(runtime.process),
    messageAdapterType: definition.messageAdapterType ?? "napcat",
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    rolesDir: definition.rolesDir,
    roleInfo: roleInfoFor(definition, false, roleInfoCatalogCache),
    roleRouteNames: definition.roleRouteNames,
    napcatInstances,
    codexCwd: definition.codexCwd,
    dataDir: definition.dataDir,
    notificationRules: definition.notificationRules
  };
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  if (statusCode >= 400) {
    const context = managerRequestContexts.get(response);
    const responseBody = body as { message?: unknown; error?: unknown } | null;
    const failure = responseBody?.message ?? responseBody?.error ?? `HTTP ${statusCode}`;
    managerOperationalLog.record(statusCode >= 500 ? "error" : "warn", "http_response_error", {
      requestId: context?.requestId,
      method: context?.method,
      pathname: context?.pathname(),
      statusCode,
      durationMs: context ? Math.max(0, Date.now() - context.startedAt) : undefined,
      result: "failed",
      error: managerOperationalError(failure, rootDir)
    });
  }
  const serialized = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerHttpJsonSerialize,
    () => JSON.stringify(body)
  );
  const context = managerRequestContexts.get(response);
  if (context) context.responseBytes = Buffer.byteLength(serialized);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(serialized);
}

function readJsonBody<T>(request: http.IncomingMessage, maxBytes = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (maxBytes > 0 && total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        if (tooLarge) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function readBodyBuffer(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

type ManualTriggerRequest = {
  triggerId?: string;
  triggerName?: string;
  message?: string;
  routeKind?: string;
  ruleId?: string;
  triggerSource?: "manual" | "auto";
};

type DeliveryReplayRequest = {
  attemptId?: string;
  attemptIds?: string[];
  routeKind?: string;
  messageId?: string;
  mode?: "single" | "merge";
};

type RolePanelMessageRequest = {
  gatewayId?: string;
  text?: string;
  attachments?: RolePanelAttachment[];
};

type PlanFeedbackRequest = {
  feedbackId?: string;
  gatewayId?: string;
  stepId?: string;
  text?: string;
  kind?: "guidance" | "guidance_response" | "approval_suggestion" | "approval_response";
  author?: "user" | "agent" | "system";
  source?: "webgui" | "tray" | "qq" | "agent" | "api";
  attachments?: PlanFeedbackAttachmentUpload[];
  planAttachmentIds?: string[];
  notifyAgent?: boolean;
};

const manualTriggerProcesses = new ManualTriggerProcessRegistry();

type ManualTriggerCompletionCallbacks = {
  onSuccess?: () => void;
  onFailure?: (error: Error) => void;
};

function triggerGatewayManualRule(
  id: string,
  request: ManualTriggerRequest = {},
  completion: ManualTriggerCompletionCallbacks = {}
): ManualTriggerLaunchResult {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }

  const triggerId = sanitizeRoleId(request.triggerId) || "manual";
  const triggerName = request.triggerName?.trim() || triggerId;
  const message = request.message?.trim() || triggerName;
  const routeKind = normalizeManualRouteKind(request.routeKind);
  const triggerSource = request.triggerSource === "auto" ? "auto" : "manual";
  const ruleId = sanitizeRoleId(request.ruleId) || (routeKind === "heartbeat" ? "" : triggerId);
  const args = [
    `--manual-trigger=${triggerId}`,
    `--manual-name=${encodeURIComponent(triggerName)}`,
    `--manual-message=${encodeURIComponent(message)}`,
    `--manual-route-kind=${routeKind}`,
    `--manual-source=${triggerSource}`
  ];
  if (ruleId) {
    args.push(`--manual-rule=${ruleId}`);
  }
  const command = childCommand(args);
  const processKey = `${id}:${routeKind}:${triggerId}`;
  const result = manualTriggerProcesses.launch(
    processKey,
    () => {
      appendLog(runtime, `manual trigger requested: ${triggerName}`);
      return spawn(command.command, command.args, {
        cwd: rootDir,
        env: envFor(runtime.definition),
        shell: command.shell,
        windowsHide: true
      });
    },
    {
      onStdout: (text) => {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          appendLog(runtime, `manual trigger: ${line}`);
        }
      },
      onStderr: (text) => {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          appendLog(runtime, `manual trigger error: ${line}`);
        }
      },
      onError: (error) => {
        appendLog(runtime, `manual trigger process error: ${error.message}`);
        completion.onFailure?.(error);
      },
      onExit: (code, signal) => {
        if (code === 0) {
          appendLog(runtime, `manual trigger completed: ${triggerName}`);
          completion.onSuccess?.();
          return;
        }
        const error = new Error(`manual trigger failed: code=${code ?? "null"} signal=${signal ?? "null"}`);
        appendLog(runtime, error.message);
        completion.onFailure?.(error);
      }
    }
  );
  if (result.alreadyRunning) {
    appendLog(runtime, `manual trigger already running: ${triggerName}`);
  }
  return result;
}

function normalizeManualRouteKind(value: unknown): ForwardRouteKind {
  return value === "heartbeat" ? "heartbeat" : "manual_trigger";
}

function routeDataDirForDefinition(definition: GatewayDefinition): string {
  const configName = routeRuntimeParts(definition.id).configName || sanitizeConfigName(definition.name ?? definition.id);
  return routeFolderPath(routeRoot, configName);
}

function listGatewayDeliveryReplayAttempts(id: string, limit: number, status: string | null): Record<string, unknown> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const dataDir = routeDataDirForDefinition(runtime.definition);
  return {
    gatewayId: id,
    dataDir: path.relative(rootDir, dataDir).replace(/\\/g, "/"),
    attempts: listDeliveryReplayAttempts(dataDir, {
      status: status === "failed" || status === "delivered" || status === "missed" || status === "routed" || status === "skipped" ? status : undefined,
      limit
    }).map((attempt) => ({
      attemptId: attempt.attemptId,
      time: attempt.time,
      routeKind: attempt.routeKind,
      messageId: attempt.messageId,
      status: attempt.result.status,
      matchedRuleCount: attempt.result.matchedRuleCount,
      sentPacketCount: attempt.result.sentPacketCount,
      failedAdapterCount: attempt.result.adapterOutcomes.filter((outcome) => outcome.status === "failed").length,
      packetCount: attempt.packets.length,
      replayOfAttemptId: attempt.replayOfAttemptId
    }))
  };
}

function replayGatewayDelivery(id: string, request: DeliveryReplayRequest = {}): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const attemptIds = (request.attemptIds?.length ? request.attemptIds : request.attemptId ? [request.attemptId] : [])
    .map((item) => String(item).trim())
    .filter(Boolean);
  const routeKind = parseReplayRouteKind(request.routeKind);
  const messageId = request.messageId?.trim();
  if (attemptIds.length === 0 && (!routeKind || !messageId)) {
    throw new Error("No delivery replay attempt id was provided.");
  }

  const mode = request.mode === "merge" || attemptIds.length > 1 ? "merge" : "single";
  const args = [
    `--delivery-replay-mode=${mode}`
  ];
  if (attemptIds.length > 0) {
    args.push(`--delivery-replay=${encodeURIComponent(attemptIds.join(","))}`);
  }
  if (routeKind && messageId) {
    args.push(`--delivery-replay-route-kind=${routeKind}`, `--delivery-replay-message=${encodeURIComponent(messageId)}`);
  }
  const command = childCommand(args);
  appendLog(runtime, `delivery replay requested: mode=${mode} attempts=${attemptIds.join(",") || "none"} message=${routeKind && messageId ? `${routeKind}:${messageId}` : "none"}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `delivery replay: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `delivery replay error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `delivery replay completed: mode=${mode} attempts=${attemptIds.length}`);
        resolve();
        return;
      }
      reject(new Error(`delivery replay failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function parseReplayRouteKind(value: unknown): ForwardRouteKind | undefined {
  return value === "private"
    || value === "group_message"
    || value === "direct_at"
    || value === "direct_reply"
    || value === "indirect_reply"
    || value === "heartbeat"
    || value === "manual_trigger"
    || value === "role_panel_message"
    || value === "plan_feedback"
    || value === "voice_transcript"
    ? value
    : undefined;
}

function roleDirForDefinition(definition: GatewayDefinition): string {
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleId = sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
  return roleFolderPath(rolesDir, roleId);
}

function memoryConsolidationScheduleTargets(): MemoryConsolidationScheduleTarget[] {
  return runtimes.values()
    .filter((runtime) => runtime.definition.enabled !== false)
    .map((runtime) => {
      const roleDir = roleDirForDefinition(runtime.definition);
      return {
        gatewayId: runtime.definition.id,
        roleKey: path.resolve(roleDir).toLowerCase(),
        roleDir
      };
    });
}

function deliverAutomaticMemoryConsolidation(
  target: MemoryConsolidationScheduleTarget,
  run: DueMemoryConsolidationRun
): Promise<void> {
  return new Promise((resolve, reject) => {
    const result = triggerGatewayManualRule(target.gatewayId, {
      triggerId: "memory-consolidation",
      triggerName: "记忆沉淀",
      message: `近期记忆已到达 72 小时触发时间，请处理沉淀批次 ${run.runId}。`,
      routeKind: "manual_trigger",
      ruleId: "memory-consolidation",
      triggerSource: "auto"
    }, {
      onSuccess: () => {
        try {
          markMemoryConsolidationRunDelivered(target.roleDir, run.runId);
          const runtime = runtimes.get(target.gatewayId);
          publishManagerEvent("memory_consolidation_changed", {
            gatewayId: target.gatewayId,
            roleId: runtime ? roleIdForDefinition(runtime.definition) : "",
            runId: run.runId,
            status: "requested"
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      onFailure: reject
    });
    if (result.alreadyRunning) resolve();
  });
}

function createMemoryConsolidationScheduler(): MemoryConsolidationScheduler {
  return new MemoryConsolidationScheduler({
    listTargets: memoryConsolidationScheduleTargets,
    requestDueRun: (target) => {
      const request = pendingMemoryConsolidation(target.roleDir, "auto");
      return request ? { runId: request.run.id, delivered: Boolean(request.run.deliveredAt) } : null;
    },
    nextTriggerAt: (target) => nextMemoryConsolidationTriggerAt(target.roleDir),
    deliver: deliverAutomaticMemoryConsolidation,
    onError: (target, error) => {
      const runtime = runtimes.get(target.gatewayId);
      const message = error instanceof Error ? error.message : String(error);
      if (runtime) appendLog(runtime, `automatic memory consolidation failed: ${message}`);
      managerOperationalLog.record("error", "memory_consolidation_auto_failed", {
        result: `gatewayId=${target.gatewayId}; ${message}`
      });
    }
  });
}

function roleIdForDefinition(definition: GatewayDefinition): string {
  return sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
}

function roleIdsForPlanBoundSession(sessionId: string, cwd?: string): Set<string> {
  const roleIds = new Set<string>();
  try {
    for (const entry of fs.readdirSync(rolesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const roleDir = path.join(rolesRoot, entry.name);
      for (const plan of listPlans(roleDir)) {
        const bindings = [plan.taskBinding, plan.secretaryBinding];
        if (bindings.some((binding) => binding?.sessionId === sessionId && hookWorkspaceMatches(binding.workspace, cwd))) {
          roleIds.add(sanitizeRoleId(entry.name) || entry.name);
          break;
        }
      }
    }
  } catch {
    return roleIds;
  }
  return roleIds;
}

function gatewayIdsForManagedSession(sessionId: string, cwd?: string): Set<string> {
  const exactSessionId = String(sessionId || "").trim();
  const gatewayIds = new Set<string>();
  for (const runtime of runtimes.values()) {
    if (
      String(runtime.definition.codexThreadId || "").trim() === exactSessionId
      && hookWorkspaceMatches(runtime.definition.codexCwd, cwd)
    ) {
      gatewayIds.add(runtime.definition.id);
    }
  }
  for (const requirement of messageProcessingBoard.list({ limit: 10_000 })) {
    if (
      (requirement.worker?.threadId === exactSessionId && hookWorkspaceMatches(requirement.worker.workspace, cwd))
      || requirement.handoff?.targetThreadId === exactSessionId
    ) {
      gatewayIds.add(requirement.source.routeId);
    }
  }
  const roleIds = roleIdsForPlanBoundSession(exactSessionId, cwd);
  if (roleIds.size > 0) {
    for (const runtime of runtimes.values()) {
      if (roleIds.has(roleIdForDefinition(runtime.definition))) gatewayIds.add(runtime.definition.id);
    }
  }
  return gatewayIds;
}

function codexHookSettingsForSession(sessionId: string, cwd?: string): CodexHookSettings {
  const exactSessionId = String(sessionId || "").trim();
  const managedGatewayIds = gatewayIdsForManagedSession(exactSessionId, cwd);
  const matches = [...runtimes.values()].filter((runtime) => (
    normalizeAgentAdapters(runtime.definition.agentAdapters).includes("codex")
    && managedGatewayIds.has(runtime.definition.id)
  ));
  if (matches.length === 0) return { ...DEFAULT_CODEX_HOOK_SETTINGS };
  const settings = matches.map((runtime) => normalizeCodexHookSettings(runtime.definition.codexHooks));
  return {
    sessionContextEnabled: settings.every((item) => item.sessionContextEnabled),
    reasoningContextEnabled: settings.every((item) => item.reasoningContextEnabled),
    planTaskCompletionEnabled: settings.every((item) => item.planTaskCompletionEnabled),
    agentCommunicationEnforcementEnabled: settings.every((item) => item.agentCommunicationEnforcementEnabled)
  };
}

function codexHookEnabled(request: CodexHookContextRequest): boolean {
  const settings = codexHookSettingsForSession(request.sessionId, request.cwd);
  if (request.eventName === "SessionStart" || request.eventName === "UserPromptSubmit") {
    return settings.sessionContextEnabled;
  }
  if (request.eventName === "PreToolUse" || request.eventName === "PostToolUse") {
    return settings.reasoningContextEnabled;
  }
  return settings.planTaskCompletionEnabled;
}

function hookWorkspaceMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return true;
  return normalizePathForComparison(expected) === normalizePathForComparison(actual);
}

function isManagedAgentSession(request: CodexHookContextRequest): boolean {
  const sessionId = String(request.sessionId || "").trim();
  if (!sessionId) return false;
  const managed = agentRequests.hasManagedSession(sessionId, request.cwd)
    || gatewayIdsForManagedSession(sessionId, request.cwd).size > 0;
  if (!managed) return false;
  return codexHookSettingsForSession(sessionId, request.cwd).agentCommunicationEnforcementEnabled;
}

function recordAgentRequestStop(request: CodexHookContextRequest): AgentRequestStopResult {
  if (managerReadOnly) return { status: "ignored", reason: "manager_read_only", turnId: request.turnId };
  const turnId = String(request.turnId || "").trim();
  if (!turnId) return { status: "ignored", reason: "missing_turn_id" };
  const scheduled = agentRequests.recordTargetTurnEnded(request.sessionId, request.cwd, turnId);
  for (const item of scheduled) scheduleAgentRequestReminder(item);
  if (!scheduled.length) {
    return { status: "ignored", reason: "no_unanswered_agent_requests", turnId };
  }
  publishManagerEvent("agent_requests_changed", {
    requestIds: scheduled.map((item) => item.id),
    status: "awaiting_response",
    nextReminderAt: scheduled[0]?.nextReminderAt
  });
  return {
    status: "scheduled",
    reason: "target_turn_ended_without_response",
    requestIds: scheduled.map((item) => item.id),
    turnId
  };
}

function agentRequestReminderPrompt(request: AgentRequestRecord): string {
  const sourceWorkspace = request.source.workspace || "<原请求任务工作目录>";
  return [
    "[Rabi Agent 请求回复提醒]",
    `requestId：${request.id}`,
    `原请求任务：${request.source.threadName || request.source.threadId}`,
    `原请求任务 ID：${request.source.threadId}`,
    `需要回答：${request.responseInstruction}`,
    "上一轮迭代结束时没有检测到通过 RabiRoute 接口提交的正式回复。普通 Codex 最终文字不算回复。",
    "请完成判断后调用 POST /api/agent/threads，并填写：",
    `action=send、threadId=${request.source.threadId}、cwd=${sourceWorkspace}、deliverySource={agentAdapter=当前 Agent 端，sessionId=当前任务完整 ID，sessionName=当前任务名称}、sourceThreadId=当前任务完整 ID、sourceAgentType=当前 Agent 类型、inReplyToRequestId=${request.id}、result=结果或决定、nextAction=下一步、responsePolicy=required 或 none、prompt=重新编写的回复内容。`,
    "如果下一步仍要求原请求方处理完再返回，填写 responsePolicy=required 和 responseInstruction；如果本次回复结束往返，填写 responsePolicy=none。"
  ].join("\n");
}

function scheduleAgentRequestReminder(request: AgentRequestRecord): void {
  const existing = agentRequestReminderTimers.get(request.id);
  if (existing) clearTimeout(existing);
  agentRequestReminderTimers.delete(request.id);
  if (request.status !== "awaiting_response" || !request.nextReminderAt) return;
  const delay = Math.max(0, Date.parse(request.nextReminderAt) - Date.now());
  const timer = setTimeout(() => {
    agentRequestReminderTimers.delete(request.id);
    void deliverAgentRequestReminder(request.id);
  }, Math.min(delay, 2_147_000_000));
  timer.unref();
  agentRequestReminderTimers.set(request.id, timer);
}

async function deliverAgentRequestReminder(requestId: string): Promise<void> {
  const request = agentRequests.get(requestId);
  if (!request || request.status !== "awaiting_response" || !request.nextReminderAt) return;
  if (Date.parse(request.nextReminderAt) > Date.now()) {
    scheduleAgentRequestReminder(request);
    return;
  }
  try {
    const messageProcessingTarget = currentMessageProcessingTargetByThreadId(request.target.threadId)
      ?? ((request.target.agentType === "message_processing" || request.target.agentType === "primary_persona")
        && request.target.threadName
        && request.target.workspace
        ? {
            agentType: request.target.agentType,
            worker: {
              threadId: request.target.threadId,
              threadName: request.target.threadName,
              workspace: request.target.workspace
            }
          } as MessageProcessingDeliveryTarget
        : undefined);
    const target = messageProcessingTarget?.worker ?? request.target;
    const result = await handleAgentThreadRequest({
      action: "send",
      threadId: target.threadId,
      ...(target.threadName ? { title: target.threadName, createIfMissing: true } : {}),
      cwd: target.workspace,
      deliverySource: agentDeliverySourceForSession(request.source.threadId, request.source.threadName),
      prompt: agentRequestReminderPrompt(request)
    }, {
      allowedWorkspaces: agentThreadAllowedWorkspaces(),
      defaultWorkspace: rootDir,
      agentRequests
    });
    if (result.data.status !== "delivered") {
      throw new Error(String(result.data.warning || result.data.message || "Agent request reminder was not accepted."));
    }
    if (messageProcessingTarget) {
      persistResolvedMessageProcessingTarget(
        messageProcessingTarget,
        result.data,
        runtimeForMessageProcessingTarget(messageProcessingTarget)
      );
    } else {
      persistResolvedAgentRequestTarget(target, result.data);
    }
    const updated = agentRequests.recordReminderResult(requestId, true);
    publishManagerEvent("agent_requests_changed", {
      requestId,
      status: updated.status,
      reminderCount: updated.reminderCount,
      lastReminderAt: updated.lastReminderAt
    });
  } catch (error) {
    const updated = agentRequests.recordReminderResult(requestId, false, error);
    managerOperationalLog.record("warn", "agent_request_reminder_failed", {
      result: "failed",
      requestId,
      error: managerOperationalError(error, rootDir)
    });
    publishManagerEvent("agent_requests_changed", {
      requestId,
      status: updated.status,
      reminderCount: updated.reminderCount,
      lastReminderError: updated.lastReminderError,
      nextReminderAt: updated.nextReminderAt
    });
    scheduleAgentRequestReminder(updated);
  }
}

function refreshAgentRequestReminderTimers(): void {
  const current = new Map(agentRequests.list().map((request) => [request.id, request]));
  for (const [requestId, timer] of agentRequestReminderTimers) {
    const request = current.get(requestId);
    if (request?.status === "awaiting_response" && request.nextReminderAt) continue;
    clearTimeout(timer);
    agentRequestReminderTimers.delete(requestId);
  }
  for (const request of current.values()) scheduleAgentRequestReminder(request);
}

function agentThreadAllowedWorkspaces(): string[] {
  let desktopWorkspaces: string[] = [];
  try {
    desktopWorkspaces = listCodexDesktopThreads({ limit: 10_000 })
      .map((thread) => thread.cwd?.trim())
      .filter((value): value is string => Boolean(value));
  } catch {
    // Keep configured workspaces available when Desktop state is temporarily unreadable.
  }
  return [...new Set([
    rootDir,
    ...desktopWorkspaces,
    ...[...runtimes.values()]
      .map((runtime) => runtime.definition.codexCwd?.trim())
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(rootDir, value))
  ])];
}

const speechModelManager = new SpeechModelManager({
  rootDir,
  onChange: snapshot => publishManagerEvent("speech_model_management_changed", {
    activeJob: snapshot.activeJob,
    lastJob: snapshot.lastJob
  })
});

function applyManagedAgentThreadDefaults(request: AgentThreadRequest): AgentThreadRequest {
  if (request.action !== "send") return request;
  const model = resolveCodexPlanAssistantTurnModel(
    [...runtimes.values()].flatMap((runtime) => runtime.definition.codexPlanAssistantEnabled === true
      ? (runtime.definition.codexPlanAssistantSessions ?? []).map((session) => ({
          ...session,
          model: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel)
        }))
      : []),
    request.threadId,
    request.model
  );
  return model && !request.model?.trim() ? { ...request, model } : request;
}

function messageProcessingRequirementIdFromSend(request: AgentSendRequest): string | undefined {
  const tracking = request.tracking && typeof request.tracking === "object" && !Array.isArray(request.tracking)
    ? request.tracking as Record<string, unknown>
    : undefined;
  const value = String(tracking?.requirementId || "").trim();
  return value || undefined;
}

function recordMessageProcessingSend(request: AgentSendRequest, result: AgentSendResult): void {
  const requirementId = messageProcessingRequirementIdFromSend(request);
  if (!requirementId) return;
  try {
    const requirement = messageProcessingBoard.recordSend(requirementId, result, String(request.deliveryId || "").trim() || undefined);
    publishManagerEvent("message_processing_board_changed", { requirementId, status: result.status });
    if (requirement.status === "awaiting_send" && result.status === "sent") {
      managerOperationalLog.record("warn", "message_processing_send_channel_mismatch", {
        action: requirementId,
        result: `${result.status}:${result.channel || "unknown"}->${requirement.source.endpoint}`,
        error: requirement.lastError ? { name: "SendChannelMismatch", message: requirement.lastError } : undefined
      });
    }
  } catch (error) {
    managerOperationalLog.record("warn", "message_processing_send_board_update_failed", {
      action: requirementId,
      result: result.status,
      error: managerOperationalError(error, rootDir)
    });
  }
}

async function dispatchPlanNotificationRequirement(requirement: MessageProcessingRequirement): Promise<void> {
  if (requirement.kind !== "plan_progress_notification") return;
  const target = currentMessageProcessingTarget(requirement);
  const worker = target?.worker;
  if (!target || !worker?.threadId || !worker.workspace) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, "当前 Route 没有可用的主人格或消息处理 Agent 任务；等待配置恢复或人工重新分配。");
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
    return;
  }
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, "当前 Route 没有可核对的主人格来源会话，未投递计划进展通知。");
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
    return;
  }
  const deliverySource = primaryAgentDeliverySource(runtime.definition);
  const outcomeUrl = `http://127.0.0.1:${managerPort}/api/message-processing/requirements/${encodeURIComponent(requirement.id)}/outcome`;
  const sendContextUrl = `http://127.0.0.1:${managerPort}/api/message-processing/requirements/${encodeURIComponent(requirement.id)}/send-context`;
  const sendApiUrl = `http://127.0.0.1:${managerPort}/api/agent/send`;
  const sendRequestTemplate = agentSendRequestTemplateForSource({
    ...(requirement.source.replyContext || {}),
    routeProfileId: requirement.source.routeProfileId || requirement.source.routeId,
    messageProcessingRequirementId: requirement.id
  });
  const prompt = [
    "[计划进展通知需求]",
    `消息处理需求 ID：${requirement.id}`,
    `计划：${requirement.plan?.planTitle || requirement.plan?.planId}`,
    `计划 ID：${requirement.plan?.planId}`,
    `原消息端：${requirement.source.endpoint}`,
    `原会话：${requirement.source.conversationKey}`,
    `原说话人：${requirement.source.sender}`,
    `原消息编号：${requirement.source.messageIds.join(", ") || "无"}`,
    "本次变化：",
    ...(requirement.plan?.changes || []).map((change) => `- ${change}`),
    "",
    "RabiManager 已自动生成一项必须发送的计划进展通知。请结合计划当前内容整理简短、可理解的进展，不要把内部 taskBinding、路径或控制面字段原样发给群成员。",
    `先 POST ${outcomeUrl} 提交 decision=reply，再 GET ${sendContextUrl}?sourceMessageId=<本次拟引用的原消息ID> 读取精确来源和最新双向消息。确认没有他人已经通知、没有新消息改变结论后，POST ${sendContextUrl} 审核确切 proposedSend，并把返回 token 写入 tracking.sendContextReviewToken。`,
    `最后使用 POST ${sendApiUrl}，明确填写 routeId、channel、params、payload、deliveryId，并在 tracking.requirementId 填 ${requirement.id}。不要把来源 replyContext 原样当发送参数。`,
    `发送请求模板：${JSON.stringify(sendRequestTemplate || { error: "当前来源无法生成明确发送目标，请提交 invalid_source，不要猜测。" })}`,
    `当前 replyContext：${JSON.stringify(requirement.source.replyContext || {})}`,
    `如果来源已经失效或同一进展已由别人完整通知，POST ${outcomeUrl} 提交 decision=no_reply 和受支持的原因；其它情况不能静默关闭。`,
    "普通问题和讨论仍由你判断是否参与；这条计划进展通知本身不是可选讨论。"
  ].join("\n");
  try {
    const result = await handleAgentThreadRequest({
      action: "send",
      threadId: worker.threadId,
      title: worker.threadName,
      createIfMissing: true,
      cwd: worker.workspace,
      sandbox: "workspace-write",
      deliverySource,
      prompt
    }, {
      allowedWorkspaces: agentThreadAllowedWorkspaces(),
      defaultWorkspace: rootDir
    });
    if (result.data.status !== "delivered") {
      throw new Error(String(result.data.warning || result.data.message || "Plan notification was not accepted."));
    }
    const resolved = persistResolvedMessageProcessingTarget(
      target,
      result.data,
      runtime
    );
    messageProcessingBoard.recordDispatch(requirement.id, resolved.worker);
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "processing" });
  } catch (error) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, error);
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
  }
}

const knowledgeCallbackReminderTimers = new Map<string, NodeJS.Timeout>();

function runtimeForMessageProcessingRequirement(requirement: MessageProcessingRequirement): GatewayRuntime | undefined {
  const routeIds = [requirement.source.routeId, requirement.source.routeProfileId].filter(Boolean);
  for (const routeId of routeIds) {
    const exact = runtimes.get(String(routeId));
    if (exact) return exact;
  }
  return [...runtimes.values()].find((runtime) =>
    routeIds.some((routeId) => (runtime.definition.routeProfiles ?? []).some((profile) => profile.id === routeId))
  );
}

function currentMessageProcessingWorker(requirement: MessageProcessingRequirement): MessageProcessingRequirement["worker"] {
  return currentMessageProcessingTarget(requirement)?.worker;
}

function currentMessageProcessingTarget(requirement: MessageProcessingRequirement): MessageProcessingDeliveryTarget | undefined {
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    return requirement.worker
      ? { agentType: "message_processing", worker: requirement.worker }
      : undefined;
  }
  const maxAgents = runtime.definition.messageProcessingAgents?.codex?.maxAgents;
  const messageAgentModeEnabled = codexMessageProcessingAgentEnabled(runtime.definition);
  const managedWorker = messageAgentModeEnabled
    ? resolveCurrentMessageAgentWorker(
      messageAgentPoolStatePath(dataDirFor(runtime.definition)),
      requirement.worker,
      maxAgents,
      {
        groupId: requirement.messageGroupId || requirement.id,
        endpoint: requirement.source.endpoint,
        conversationKey: requirement.source.conversationKey,
        sender: requirement.source.sender
      }
    )
    : undefined;
  return resolveMessageProcessingDeliveryTarget(runtime.definition, managedWorker);
}

function runtimeForMessageProcessingTarget(target: MessageProcessingDeliveryTarget): GatewayRuntime | undefined {
  if (target.agentType === "primary_persona") {
    return [...runtimes.values()].find((runtime) =>
      (String(runtime.definition.codexThreadId || "").trim() === target.worker.threadId
        && String(runtime.definition.codexCwd || "").trim() === target.worker.workspace)
      || (String(runtime.definition.dshSessionId || "").trim() === target.worker.threadId
        && String(runtime.definition.dshCwd || "").trim() === target.worker.workspace)
    );
  }
  return [...runtimes.values()].find((runtime) => readCurrentMessageAgentWorkers(
    messageAgentPoolStatePath(dataDirFor(runtime.definition))
  ).some((worker) => worker.threadId === target.worker.threadId));
}

function replaceOpenAgentRequestParties(
  previousThreadId: string,
  worker: NonNullable<MessageProcessingRequirement["worker"]>
): void {
  const result = agentRequests.reconcileOpenParties((party) => party.threadId === previousThreadId
    ? {
        ...party,
        threadId: worker.threadId,
        threadName: worker.threadName,
        workspace: worker.workspace
      }
    : undefined);
  if (!result.reassigned.length && !result.cancelled.length) return;
  publishManagerEvent("agent_requests_changed", {
    status: "archived_task_binding_replaced",
    previousThreadId,
    threadId: worker.threadId,
    reassignedRequestIds: result.reassigned.map((request) => request.id),
    cancelledRequestIds: result.cancelled.map((request) => request.id)
  });
}

function persistResolvedAgentRequestTarget(
  target: { threadId: string; threadName?: string; workspace?: string },
  result: Record<string, unknown>
): void {
  const previousThreadId = String(result.previousThreadId || "").trim();
  const thread = result.thread && typeof result.thread === "object"
    ? result.thread as { id?: unknown; title?: unknown; cwd?: unknown }
    : undefined;
  const threadId = String(thread?.id || result.threadId || "").trim();
  if (!previousThreadId || previousThreadId !== target.threadId || !threadId || threadId === previousThreadId) return;
  replaceOpenAgentRequestParties(previousThreadId, {
    threadId,
    threadName: String(thread?.title || target.threadName || threadId),
    workspace: String(thread?.cwd || target.workspace || rootDir)
  });
}

function persistResolvedMessageProcessingTarget(
  target: MessageProcessingDeliveryTarget,
  result: Record<string, unknown>,
  runtime: GatewayRuntime | undefined
): MessageProcessingDeliveryTarget {
  const resolved = resolveDeliveredMessageProcessingTarget(target, result);
  if (!resolved.previousThreadId) return resolved.target;
  if (!runtime) {
    throw new Error(`Cannot persist replacement for archived ${target.agentType} task ${resolved.previousThreadId}.`);
  }
  const replacement = resolved.target.worker;
  if (target.agentType === "primary_persona") {
    const configuredThreadId = String(runtime.definition.codexThreadId || "").trim();
    if (configuredThreadId !== resolved.previousThreadId && configuredThreadId !== replacement.threadId) {
      throw new Error(`Primary Persona binding changed before archived task replacement could be saved: ${configuredThreadId}`);
    }
    if (configuredThreadId !== replacement.threadId) {
      runtime.definition.codexThreadId = replacement.threadId;
      runtime.definition.codexThreadName = replacement.threadName;
      runtime.definition.codexCwd = replacement.workspace;
      writeAdapterConfigFile(runtime.definition);
    }
  } else {
    const statePath = messageAgentPoolStatePath(dataDirFor(runtime.definition));
    const replaced = replacePersistedMessageAgentWorker(
      statePath,
      resolved.previousThreadId,
      replacement
    );
    const alreadyPersisted = !replaced && readCurrentMessageAgentWorkers(statePath)
      .some((worker) => worker.threadId === replacement.threadId);
    if (!replaced && !alreadyPersisted) {
      throw new Error(`Message Agent replacement could not be saved: ${resolved.previousThreadId}`);
    }
  }
  messageProcessingBoard.replaceWorkerReferences(resolved.previousThreadId, replacement);
  replaceOpenAgentRequestParties(resolved.previousThreadId, replacement);
  reconcileMessageProcessingAgentRequests();
  publishManagerEvent("codex_binding_replaced", {
    gatewayId: runtime.definition.id,
    agentType: target.agentType,
    previousThreadId: resolved.previousThreadId,
    threadId: replacement.threadId,
    workspace: replacement.workspace
  });
  return resolved.target;
}

function currentMessageProcessingTargetByThreadId(threadId: string): MessageProcessingDeliveryTarget | undefined {
  const historicalTargets = messageProcessingBoard.snapshot().requirements
    .filter((requirement) => requirement.worker?.threadId === threadId)
    .flatMap((requirement) => {
      const target = currentMessageProcessingTarget(requirement);
      return target ? [target] : [];
    });
  const uniqueHistoricalTargets = [...new Map(historicalTargets.map((target) => [
    `${target.agentType}\n${target.worker.threadId}\n${target.worker.workspace}`,
    target
  ])).values()];
  if (uniqueHistoricalTargets.length === 1) return uniqueHistoricalTargets[0];
  if (uniqueHistoricalTargets.length > 1) return undefined;
  const candidates = [...runtimes.values()].flatMap((runtime) => {
    const modeEnabled = codexMessageProcessingAgentEnabled(runtime.definition);
    const workers = readCurrentMessageAgentWorkers(
      messageAgentPoolStatePath(dataDirFor(runtime.definition)),
      modeEnabled ? runtime.definition.messageProcessingAgents?.codex?.maxAgents : undefined
    );
    const matchingWorker = workers.find((worker) => worker.threadId === threadId);
    if (!matchingWorker) return [];
    const target = resolveMessageProcessingDeliveryTarget(
      runtime.definition,
      modeEnabled
        ? {
            threadId: matchingWorker.threadId,
            threadName: matchingWorker.threadName,
            workspace: matchingWorker.workspace
          }
        : undefined
    );
    return target ? [target] : [];
  });
  const unique = [...new Map(candidates.map((target) => [
    `${target.agentType}\n${target.worker.threadId}\n${target.worker.workspace}`,
    target
  ])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

function reconcileMessageProcessingAgentRequests(): void {
  const knownMessageWorkers = new Set(messageProcessingBoard.snapshot().requirements
    .flatMap((requirement) => requirement.worker?.threadId ? [requirement.worker.threadId] : []));
  const result = agentRequests.reconcileOpenParties((party, record) => {
    const isMessageProcessingParty = party.agentType === "message_processing" || knownMessageWorkers.has(party.threadId);
    if (!isMessageProcessingParty) return undefined;
    const requirement = record.messageProcessingRequirementId
      ? messageProcessingBoard.getRequirement(record.messageProcessingRequirementId)
      : undefined;
    const target = requirement
      ? currentMessageProcessingTarget(requirement)
      : currentMessageProcessingTargetByThreadId(party.threadId);
    if (!target) return null;
    const worker = target.worker;
    const agentType = target.agentType;
    if (worker.threadId === party.threadId && agentType === party.agentType) return undefined;
    return {
      threadId: worker.threadId,
      threadName: worker.threadName,
      workspace: worker.workspace,
      agentType
    };
  });
  if (!result.reassigned.length && !result.cancelled.length) return;
  managerOperationalLog.record("info", "message_agent_request_bindings_reconciled", {
    result: `reassigned=${result.reassigned.length};cancelled=${result.cancelled.length}`,
    action: [...result.reassigned, ...result.cancelled].map((request) => request.id).join(",")
  });
  publishManagerEvent("agent_requests_changed", {
    status: "message_agent_bindings_reconciled",
    reassignedRequestIds: result.reassigned.map((request) => request.id),
    cancelledRequestIds: result.cancelled.map((request) => request.id)
  });
}

export function buildKnowledgeCallbackReminderPrompt(
  requirement: MessageProcessingRequirement,
  pending: KnowledgeRecallMatch[],
  port = managerPort
): string {
  const base = `http://127.0.0.1:${port}/api/message-processing/requirements/${encodeURIComponent(requirement.id)}`;
  return [
    "[计划与记忆命中回调提醒]",
    `消息处理需求 ID：${requirement.id}`,
    `原消息 ID：${requirement.source.messageIds.join(", ") || "无"}`,
    `原消息摘要：${requirement.source.summary || "无"}`,
    "RabiManager 在投递消息后一小时仍未收到以下计划或记忆的最终回调：",
    ...pending.map((item) => `- ${item.type} ${item.id}：${item.title}（GET ${item.endpoint}）`),
    "请逐项读取并处理，然后 POST 对应 knowledge-callback。即使没有变化，也必须回调 result=unchanged 并说明核对依据。",
    "需要更新时先调用计划或记忆 PATCH/POST 接口，再回调 result=updated/created、recordType、recordId、verifiedAt，并确保记录包含原消息 ID。误命中使用 not_relevant；尚需别人处理使用 deferred，并继续跟进。",
    `需求详情：GET ${base}`,
    `回调接口：POST ${base}/knowledge-callback`,
    "群内需要确认或讨论时仍要实际发送并取得 Outbox 回执；不要只完成内部回调。"
  ].join("\n");
}

function scheduleKnowledgeCallbackReminder(requirement: MessageProcessingRequirement): void {
  const existing = knowledgeCallbackReminderTimers.get(requirement.id);
  if (existing) clearTimeout(existing);
  knowledgeCallbackReminderTimers.delete(requirement.id);
  const pending = messageProcessingBoard.pendingKnowledgeMatches(requirement.id);
  if (!pending.length || !requirement.knowledgeCallbackDueAt) return;
  const delay = Math.max(1_000, Date.parse(requirement.knowledgeCallbackDueAt) - Date.now());
  const timer = setTimeout(() => { void sendKnowledgeCallbackReminder(requirement.id); }, delay);
  timer.unref?.();
  knowledgeCallbackReminderTimers.set(requirement.id, timer);
}

async function sendKnowledgeCallbackReminder(requirementId: string): Promise<void> {
  knowledgeCallbackReminderTimers.delete(requirementId);
  const requirement = messageProcessingBoard.getRequirement(requirementId);
  if (!requirement) return;
  const pending = messageProcessingBoard.pendingKnowledgeMatches(requirementId);
  if (!pending.length) return;
  const target = currentMessageProcessingTarget(requirement);
  const worker = target?.worker;
  if (!target || !worker?.threadId || !worker.workspace) {
    scheduleKnowledgeCallbackReminder(messageProcessingBoard.recordKnowledgeReminder(requirementId));
    return;
  }
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    scheduleKnowledgeCallbackReminder(messageProcessingBoard.recordKnowledgeReminder(requirementId));
    return;
  }
  const deliverySource = primaryAgentDeliverySource(runtime.definition);
  const prompt = buildKnowledgeCallbackReminderPrompt(requirement, pending);
  try {
    const result = await handleAgentThreadRequest({
      action: "send",
      threadId: worker.threadId,
      title: worker.threadName,
      createIfMissing: true,
      cwd: worker.workspace,
      prompt,
      sandbox: "workspace-write",
      deliverySource
    }, {
      allowedWorkspaces: agentThreadAllowedWorkspaces(),
      defaultWorkspace: rootDir
    });
    if (result.data.status !== "delivered") {
      throw new Error(String(result.data.warning || result.data.message || "Knowledge callback reminder was not accepted."));
    }
    const resolved = persistResolvedMessageProcessingTarget(
      target,
      result.data,
      runtime
    );
    messageProcessingBoard.recordWorkerReference(requirement.id, resolved.worker);
  } catch (error) {
    managerOperationalLog.record("warn", "knowledge_callback_reminder_failed", {
      action: requirementId,
      error: managerOperationalError(error, rootDir)
    });
  } finally {
    scheduleKnowledgeCallbackReminder(messageProcessingBoard.recordKnowledgeReminder(requirementId));
  }
}

async function messageProcessingBoardPayload(routeId?: string, limit?: number): Promise<Record<string, unknown>> {
  if (managerReadOnly) return measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerMessageBoardSummary,
    () => messageProcessingBoard.boardSummary({ routeId, limit })
  );
  const openStatuses = new Set(["pending_dispatch", "processing", "handed_off", "awaiting_send", "awaiting_approval", "fact_record_pending", "send_failed"]);
  const boardSnapshot = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerMessageBoardSummary,
    () => messageProcessingBoard.boardSummary({ routeId, limit })
  ) as { items?: MessageProcessingRequirement[] };
  const displayItems = (boardSnapshot.items ?? []).map((item) => {
    if (!openStatuses.has(item.status)) return item;
    const worker = currentMessageProcessingWorker(item);
    return worker ? { ...item, worker } : item;
  });
  const candidates = displayItems.filter((item) => item.worker && openStatuses.has(item.status));
  const byThread = new Map<string, MessageProcessingRequirement[]>();
  const workerRuntime = new Map<string, MessageProcessingWorkerRuntimeObservation>();
  for (const item of candidates) {
    const threadId = item.worker!.threadId;
    const current = byThread.get(threadId) || [];
    current.push(item);
    byThread.set(threadId, current);
  }
  await Promise.all([...byThread.entries()].map(async ([threadId, items]) => {
    try {
      const result = await handleAgentThreadRequest({ action: "read", threadId }, {
        allowedWorkspaces: agentThreadAllowedWorkspaces(),
        defaultWorkspace: rootDir
      });
      const thread = result.data.thread as Record<string, unknown> | undefined;
      const rawStatus = String((thread?.status as Record<string, unknown> | undefined)?.type || "").trim();
      const status: MessageProcessingWorkerRuntimeStatus = new Set(["active", "idle", "notLoaded", "unavailable"]).has(rawStatus)
        ? rawStatus as MessageProcessingWorkerRuntimeStatus
        : thread?.active === true
          ? "active"
          : thread?.active === false
            ? "idle"
            : "unavailable";
      workerRuntime.set(threadId, {
        threadName: String(thread?.title || "").trim() || undefined,
        workspace: String(thread?.cwd || "").trim() || undefined,
        status,
        observedAt: new Date().toISOString()
      });
    } catch {
      workerRuntime.set(threadId, { status: "unavailable", observedAt: new Date().toISOString() });
    }
  }));
  const enriched = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerMessageBoardSummary,
    () => messageProcessingBoard.boardSummary({ routeId, limit }, workerRuntime)
  ) as Record<string, unknown> & {
    items?: MessageProcessingRequirement[];
  };
  enriched.items = (enriched.items ?? []).map((item) => {
    if (!openStatuses.has(item.status)) return item;
    const worker = currentMessageProcessingWorker(item);
    const runtime = worker ? workerRuntime.get(worker.threadId) : undefined;
    return worker
      ? {
          ...item,
          worker: {
            ...worker,
            ...(runtime?.threadName ? { threadName: runtime.threadName } : {}),
            ...(runtime?.workspace ? { workspace: runtime.workspace } : {}),
            ...(runtime ? {
              runtimeStatus: runtime.status,
              active: runtime.status === "active" ? true : runtime.status === "idle" ? false : undefined,
              observedAt: runtime.observedAt
            } : {})
          }
        }
      : item;
  });
  return enriched;
}

function setMessageProcessingPlanBaseline(item: MessageProcessingRequirement, roleIdInput?: string, planIdInput?: string): void {
  const roleId = String(roleIdInput || item.source.roleId || "").trim();
  const planId = String(planIdInput || item.plan?.planId || "").trim();
  if (!roleId || !planId) return;
  try {
    const plan = getPlan(roleDirForApi(roleId), planId);
    if (plan) messageProcessingBoard.setPlanBaseline(roleId, plan);
  } catch {
    // The linked requirement remains visible; the next plan update can establish the baseline.
  }
}

async function handleMessageProcessingPlanUpdate(roleDir: string, plan: ReturnType<typeof getPlan>): Promise<void> {
  if (!plan) return;
  const normalizedRoleDir = path.resolve(roleDir);
  for (const origin of messageProcessingBoard.planOriginList()) {
    if (origin.planId !== plan.id) continue;
    if (path.resolve(roleDirForApi(origin.roleId)) !== normalizedRoleDir) continue;
    const requirement = messageProcessingBoard.reconcilePlan(origin.key, plan);
    if (!requirement) continue;
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: requirement.status });
    await dispatchPlanNotificationRequirement(requirement);
  }
}

async function sendPlanQaFeedbackToTask(request: PlanQaTaskRequest): Promise<void> {
  if (!request.deliverySource) {
    throw new Error("Plan QA feedback delivery requires an explicit Agent delivery source.");
  }
  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: request.threadId,
    cwd: request.cwd,
    deliverySource: request.deliverySource,
    prompt: request.prompt,
    sandbox: "workspace-write"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "QA task continuation failed with HTTP " + result.statusCode + "."));
  }
}

function ensurePlanSecretaryTarget(
  runtime: GatewayRuntime,
  roleDir: string,
  plan: PlanItem
): { plan: PlanItem; target?: PlanSecretaryTarget } {
  if (runtime.definition.codexPlanAssistantEnabled !== true) return { plan };
  const assignment = resolvePlanSecretaryAssignment(plan, runtime.definition.codexPlanAssistantSessions);
  if (!assignment) return { plan };
  const assignedPlan = assignment.changed
    ? updatePlan(roleDir, plan.id, { secretaryBinding: assignment.binding })
    : plan;
  return {
    plan: assignedPlan,
    target: {
      ...assignment.target,
      model: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel)
    }
  };
}

async function sendPlanFeedbackToSecretary(
  runtime: GatewayRuntime,
  roleDir: string,
  plan: PlanItem,
  target: PlanApprovalFeedbackSecretaryTarget,
  request: PlanApprovalFeedbackPersonaRequest
): Promise<void> {
  const resolved = await resolvePlanSecretaryDeliveryTarget(runtime, roleDir, plan, target);
  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: resolved.target.threadId,
    title: resolved.target.threadName,
    createIfMissing: true,
    cwd: resolved.target.workspace,
    deliverySource: primaryAgentDeliverySource(runtime.definition),
    prompt: resolved.initializationPrompt
      ? `${resolved.initializationPrompt}\n\n${request.text}`
      : request.text,
    model: resolved.target.model,
    sandbox: "workspace-write"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan secretary feedback delivery failed with HTTP " + result.statusCode + "."));
  }
  if (resolved.initializationPrompt) markPlanSecretaryInitialized(runtime, resolved.target.threadId);
}

async function sendPlanTaskCompletionToSecretary(
  runtime: GatewayRuntime,
  target: PlanSecretaryTarget,
  delivery: PlanTaskCompletionDelivery,
  prompt: string
): Promise<void> {
  const resolved = await resolvePlanSecretaryDeliveryTarget(runtime, delivery.roleDir, delivery.plan, target);
  const result = await handleAgentThreadRequest({
    action: "send",
    threadId: resolved.target.threadId,
    title: resolved.target.threadName,
    createIfMissing: true,
    cwd: resolved.target.workspace,
    prompt: resolved.initializationPrompt
      ? `${resolved.initializationPrompt}\n\n${prompt}`
      : prompt,
    model: resolved.target.model,
    sandbox: "workspace-write",
    deliverySource: agentDeliverySourceForSession(
      delivery.sourceSessionId,
      delivery.plan.taskBinding?.sessionTitle,
      delivery.plan.taskBinding?.agentType || "codex"
    ),
    sourceThreadId: delivery.sourceSessionId,
    sourceAgentType: "plan_agent",
    responsePolicy: "required",
    responseInstruction: "消费本次阶段结果后，回复计划状态、已采取的下一步和仍需决定的事项"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    agentRequests
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan task completion delivery to secretary failed with HTTP " + result.statusCode + "."));
  }
  if (resolved.initializationPrompt) markPlanSecretaryInitialized(runtime, resolved.target.threadId);
}

function markPlanSecretaryInitialized(runtime: GatewayRuntime, threadId: string): void {
  let changed = false;
  runtime.definition.codexPlanAssistantSessions = (runtime.definition.codexPlanAssistantSessions ?? []).map((session) => {
    if (session.threadId !== threadId || session.initializedAt) return session;
    changed = true;
    return { ...session, initializedAt: new Date().toISOString() };
  });
  if (changed) writeAdapterConfigFile(runtime.definition);
}

async function resolvePlanSecretaryDeliveryTarget(
  runtime: GatewayRuntime,
  roleDir: string,
  plan: PlanItem,
  target: PlanSecretaryTarget | PlanApprovalFeedbackSecretaryTarget
): Promise<{ target: PlanSecretaryTarget; initializationPrompt?: string }> {
  const previousSession = (runtime.definition.codexPlanAssistantSessions ?? [])
    .find((session) => session.threadId === target.threadId);
  // DSH secretary endpoints are self-managed sessions: skip Codex task
  // resolution/creation and deliver directly through the DSH session bridge.
  if (isDshSessionId(target.threadId)) {
    return {
      target: {
        threadId: target.threadId,
        threadName: target.threadName,
        workspace: target.workspace,
        index: previousSession?.index ?? ("index" in target ? target.index : 1),
        model: target.model
      }
    };
  }
  const result = await handleAgentThreadRequest({
    action: "resolve",
    threadId: target.threadId,
    title: target.threadName,
    cwd: target.workspace,
    createIfMissing: true,
    lookupMode: "state_db"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan secretary task resolution failed with HTTP " + result.statusCode + "."));
  }
  const thread = result.data.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const threadId = String(thread?.id || "").trim();
  if (!threadId) throw new Error("Plan secretary task resolution did not return a task id.");
  const resolvedTarget: PlanSecretaryTarget = {
    threadId,
    threadName: String(thread?.title || target.threadName),
    workspace: String(thread?.cwd || target.workspace),
    index: previousSession?.index ?? ("index" in target ? target.index : 1),
    model: target.model
  };
  if (threadId === target.threadId) return { target: resolvedTarget };

  const sessions = runtime.definition.codexPlanAssistantSessions ?? [];
  runtime.definition.codexPlanAssistantSessions = sessions.map((session) => session.threadId === target.threadId
    ? {
        ...session,
        threadId,
        threadName: resolvedTarget.threadName,
        workspace: resolvedTarget.workspace,
        initializedAt: undefined
      }
    : session);
  writeAdapterConfigFile(runtime.definition);
  if (plan.secretaryBinding?.sessionId === target.threadId) {
    updatePlan(roleDir, plan.id, {
      secretaryBinding: {
        ...plan.secretaryBinding,
        sessionId: threadId,
        sessionTitle: resolvedTarget.threadName,
        workspace: resolvedTarget.workspace
      }
    });
  }

  const sourceThreadName = String(runtime.definition.codexThreadName || runtime.definition.name || runtime.definition.id).trim();
  const count = Math.max(1, sessions.length);
  const index = resolvedTarget.index;
  return {
    target: resolvedTarget,
    initializationPrompt: codexPlanAssistantInitializationPrompt({
      roleId: String(runtime.definition.agentRoleId || ""),
      sourceThreadId: String(runtime.definition.codexThreadId || ""),
      sourceThreadName,
      assistantThreadId: threadId,
      assistantThreadName: resolvedTarget.threadName,
      workspace: resolvedTarget.workspace,
      count,
      index
    })
  };
}

function runtimeForRoleDelivery(roleId: string, gatewayId: string): GatewayRuntime {
  if (gatewayId) {
    const runtime = runtimes.get(gatewayId);
    if (!runtime) throw new Error(`Gateway not found: ${gatewayId}`);
    if (roleIdForDefinition(runtime.definition) !== roleId) {
      throw new Error(`Gateway ${gatewayId} is not bound to role ${roleId}.`);
    }
    return runtime;
  }
  const matches = [...runtimes.values()].filter((runtime) => roleIdForDefinition(runtime.definition) === roleId);
  if (matches.length === 0) throw new Error(`No gateway is bound to role ${roleId}.`);
  if (matches.length > 1) throw new Error(`Multiple gateways are bound to role ${roleId}; gatewayId is required.`);
  return matches[0];
}

function deliverPlanTaskCompletion(delivery: PlanTaskCompletionDelivery): Promise<void> {
  return planTaskCompletionDelivery(delivery);
}

const activePlanFeedbackDeliveries = new Set<string>();
const attemptedPlanFeedbackRecoveries = new Set<string>();
const PLAN_FEEDBACK_RECOVERY_RECHECK_MS = 15_000;
let planFeedbackRecoveryTimer: NodeJS.Timeout | undefined;

function schedulePlanFeedbackDelivery(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: ReturnType<typeof listPlans>[number],
  inputRecord: PlanFeedbackRecord
): PlanFeedbackRecord {
  if (inputRecord.deliveryStatus === "record_only" || inputRecord.deliveryStatus === "delivered") return inputRecord;
  let record = inputRecord.deliveryStatus === "failed"
    ? updatePlanFeedbackDelivery(roleDir, inputRecord, "pending")
    : inputRecord;
  const deliveryKey = `${roleId}:${record.planId}:${record.id}`;
  if (activePlanFeedbackDeliveries.has(deliveryKey)) return record;

  try {
    activePlanFeedbackDeliveries.add(deliveryKey);
    const runtime = runtimeForRoleDelivery(roleId, gatewayId || String(record.gatewayId || "").trim());
    const secretaryAssignment = ensurePlanSecretaryTarget(runtime, roleDir, plan);
    publishManagerEvent("plan_feedback_changed", { roleId, planId: plan.id, feedbackId: record.id });
    void deliverPlanApprovalFeedback({
      roleId,
      managerBaseUrl: `http://127.0.0.1:${managerPort}`,
      plan: secretaryAssignment.plan,
      feedback: record,
      secretary: secretaryAssignment.target
        ? {
            threadId: secretaryAssignment.target.threadId,
            threadName: secretaryAssignment.target.threadName,
            workspace: secretaryAssignment.target.workspace,
            model: secretaryAssignment.target.model
          }
        : undefined,
      sendToTask: sendPlanQaFeedbackToTask,
      readTaskDelivery: inspectPlanFeedbackDelivery,
      sendToSecretary: (target, request) => sendPlanFeedbackToSecretary(
        runtime,
        roleDir,
        secretaryAssignment.plan,
        target,
        request
      ),
      sendToPersona: async (request) => {
        const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
        const isNotice = request.kind !== "full_feedback";
        const messageId = isNotice
          ? `plan-feedback-notice-${request.kind}-${record.id}`
          : `plan-feedback-${record.id}`;
        const deliveryAttachments: RolePanelAttachment[] = [
          ...record.attachments,
          ...record.planAttachments.map((attachment) => ({
            kind: attachment.kind === "image" ? "image" as const : "file" as const,
            name: attachment.name,
            path: attachment.path,
            size: attachment.size
          }))
        ];
        const replyContext = {
          runtimeRouteId: runtime.definition.id,
          gatewayId: runtime.definition.id,
          routeProfileId,
          routeKind: "plan_feedback",
          targetType: isNotice ? "plan_feedback_notice" : "plan_feedback",
          adapterType: "planFeedback",
          messageId,
          roleId,
          planId: plan.id,
          planStepId: record.stepId,
          planFeedbackId: record.id,
          planFeedbackResponseId: planFeedbackResponseId(record),
          planFeedbackKind: record.kind,
          planFeedbackAutoDelivered: request.kind === "auto_delivered_notice",
          planFeedbackDeliveryNoticeKind: isNotice ? request.kind : undefined,
          planAttachmentIds: record.planAttachments.map((attachment) => attachment.id)
        };
        await triggerGatewayPlanFeedback(runtime, messageId, request.text, deliveryAttachments, replyContext);
      }
    })
      .then((result) => updatePlanFeedbackDelivery(roleDir, record, "delivered", result.message))
      .catch((error) => {
        const pending = error instanceof PlanFeedbackDeliveryPendingError;
        if (pending) {
          attemptedPlanFeedbackRecoveries.delete(deliveryKey);
          queuePlanFeedbackRecoverySweep("pending delivery readback");
        }
        return updatePlanFeedbackDelivery(
          roleDir,
          record,
          pending ? "pending" : "failed",
          error instanceof Error ? error.message : String(error)
        );
      })
      .then((terminalRecord) => {
        record = terminalRecord;
        publishManagerEvent("plan_feedback_changed", { roleId, planId: plan.id, feedbackId: record.id });
      })
      .finally(() => activePlanFeedbackDeliveries.delete(deliveryKey));
    return record;
  } catch (error) {
    record = updatePlanFeedbackDelivery(
      roleDir,
      record,
      "failed",
      error instanceof Error ? error.message : String(error)
    );
    publishManagerEvent("plan_feedback_changed", { roleId, planId: plan.id, feedbackId: record.id });
    return record;
  }
}

function presentedPlanWithFeedback(roleDir: string, plan: ReturnType<typeof listPlans>[number]) {
  return {
    ...presentPlan(plan),
    approval: planFeedbackSummary(roleDir, plan.id)
  };
}

function triggerGatewayRolePanelMessage(
  runtime: GatewayRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext?: Record<string, unknown>
): Promise<void> {
  return triggerGatewayLocalAgentMessage(runtime, "role-panel", messageId, text, attachments, replyContext);
}

function triggerGatewayPlanFeedback(
  runtime: GatewayRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext: Record<string, unknown>
): Promise<void> {
  return triggerGatewayLocalAgentMessage(runtime, "plan-feedback", messageId, text, attachments, replyContext);
}

function triggerGatewayLocalAgentMessage(
  runtime: GatewayRuntime,
  argumentPrefix: "role-panel" | "plan-feedback",
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext?: Record<string, unknown>
): Promise<void> {
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
  const logLabel = argumentPrefix === "plan-feedback" ? "plan feedback" : "role panel";
  const command = childCommand([
    `--${argumentPrefix}-message=${encodeURIComponent(messageId)}`,
    `--${argumentPrefix}-text=${encodeURIComponent(text)}`,
    `--${argumentPrefix}-role=${encodeURIComponent(roleId)}`,
    `--${argumentPrefix}-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--${argumentPrefix}-route-profile=${encodeURIComponent(routeProfileId)}`,
    `--${argumentPrefix}-attachments=${encodeURIComponent(JSON.stringify(attachments))}`,
    ...(replyContext ? [`--${argumentPrefix}-reply-context=${encodeURIComponent(JSON.stringify(replyContext))}`] : [])
  ]);
  appendLog(runtime, `${logLabel} requested: ${messageId}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(() => reject(new Error(`${logLabel} timed out: ${messageId}`)));
    }, 45_000);

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `${logLabel}: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `${logLabel} error: ${line}`);
      }
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `${logLabel} completed: ${messageId}`);
        finish(resolve);
        return;
      }
      finish(() => reject(new Error(`${logLabel} failed: code=${code ?? "null"} signal=${signal ?? "null"}`)));
    });
  });
}

function triggerGatewaySpeechMessage(runtime: GatewayRuntime, record: SpeechIngressRecord): Promise<ManagerSpeechDeliveryOutcome> {
  const messageId = record.id;
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = record.routeProfileId || runtime.definition.routeProfiles?.[0]?.id || runtime.definition.id;
  const command = childCommand([
    `--speech-message=${encodeURIComponent(messageId)}`,
    `--speech-role=${encodeURIComponent(roleId)}`,
    `--speech-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--speech-route-profile=${encodeURIComponent(routeProfileId)}`
  ]);
  appendLog(runtime, `speech message requested: ${messageId}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutText = "";
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: {
        ...envFor(runtime.definition),
        RABIROUTE_SPEECH_MESSAGES_DIR: speechIngressStore.root
      },
      shell: command.shell,
      windowsHide: true
    });
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(() => reject(new SpeechControlError(
        `Speech delivery timed out before the Desktop owner confirmed receipt: ${messageId}`,
        504
      )));
    }, 40_000);
    child.stdout.on("data", (data) => {
      const textChunk = data.toString("utf8");
      stdoutText += textChunk;
      for (const line of textChunk.split(/\r?\n/).filter(Boolean)) {
        if (!line.startsWith(SPEECH_PROCESS_RESULT_MARKER)) appendLog(runtime, `speech: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) appendLog(runtime, `speech error: ${line}`);
    });
    child.on("error", (error) => finish(() => reject(new SpeechControlError(
      `Speech delivery process failed to start: ${error instanceof Error ? error.message : String(error)}`,
      502
    ))));
    child.on("close", (code, signal) => {
      finish(() => {
        const terminal = parseSpeechProcessResult(stdoutText);
        if (code === SPEECH_EXIT_DELIVERED && terminal?.status === "delivered") {
          appendLog(runtime, `speech message delivered to Desktop owner: ${messageId}`);
          resolve(terminal);
          return;
        }
        if (code === SPEECH_EXIT_RECORDED && terminal?.status === "recorded") {
          appendLog(runtime, `speech message recorded without Agent delivery: ${messageId}; ${terminal.reason || "keyword policy"}`);
          resolve(terminal);
          return;
        }
        const detail = terminal?.detail
          || `speech message failed: code=${code ?? "null"} signal=${signal ?? "null"}`;
        reject(new SpeechControlError(detail, 502));
      });
    });
  });
}

function triggerGatewayDirectAgentMessage(id: string, message: string): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const args = [`--direct-agent-message=${encodeURIComponent(message)}`];
  const command = childCommand(args);
  appendLog(runtime, "remote agent result requested direct delivery");
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `remote agent result: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `remote agent result error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, "remote agent result delivered to local agent");
        resolve();
        return;
      }
      reject(new Error(`remote agent result delivery failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function remoteAgentResultMessage(task: RemoteAgentTask, event: RemoteAgentTaskEvent): string {
  const lines = [
    "[远端 Agent 任务结果]",
    `任务 ID：${task.taskId}`,
    `远端设备：${task.deviceId}`,
    `任务类型：${task.taskKind}`,
    `状态：${event.status ?? task.status}`,
    event.summary ? `摘要：${event.summary}` : "",
    event.message ? `消息：${event.message}` : "",
    event.artifactPath ? `产物路径：${event.artifactPath}` : "",
    event.logPath ? `日志路径：${event.logPath}` : "",
    event.error ? `错误：${event.error}` : "",
    "",
    "原始任务：",
    task.message
  ].filter(Boolean);
  return lines.join("\n");
}

async function handleRemoteAgentTaskEvent(task: RemoteAgentTask, event: RemoteAgentTaskEvent): Promise<void> {
  const runtime = runtimes.get(task.originGatewayId);
  if (runtime) {
    appendLog(runtime, `remote agent task ${task.taskId} ${event.status ?? task.status}: ${event.summary || event.message || event.error || ""}`.trim());
  }
  if (event.status === "completed" || event.status === "failed") {
    if (!runtime) {
      console.warn(`Remote Agent task ${task.taskId} finished but origin gateway was not found: ${task.originGatewayId}`);
      return;
    }
    await triggerGatewayDirectAgentMessage(task.originGatewayId, remoteAgentResultMessage(task, event));
  }
}

function remoteAgentTaskWithGatewayDefaults(request: RemoteAgentTaskRequest): RemoteAgentTaskRequest {
  if (request.deviceId && request.cwd && request.threadName) {
    return request;
  }
  const originGatewayId = String(
    request.originGatewayId
    || request.gatewayId
    || request.originReplyContext?.gatewayId
    || [...runtimes.values()][0]?.definition.id
    || ""
  ).trim();
  const definition = originGatewayId ? runtimes.get(originGatewayId)?.definition : undefined;
  if (!definition) {
    return request;
  }
  return {
    ...request,
    deviceId: request.deviceId || definition.remoteAgentDefaultDeviceId,
    cwd: request.cwd || definition.remoteAgentDefaultCwd,
    threadName: request.threadName || definition.remoteAgentDefaultThreadName
  };
}

function handleRemoteAgentApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/remote-agent/devices") {
    jsonResponse(response, 200, {
      code: 0,
      devices: remoteAgentHub.listDevices(),
      tasks: remoteAgentHub.listTasks(20)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/scan") {
    void remoteAgentHub.scanLan()
      .then((devices) => jsonResponse(response, 200, {
        code: 0,
        devices,
        tasks: remoteAgentHub.listTasks(20)
      }))
      .catch((error) => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/connect") {
    void readJsonBody<{ deviceId?: string; password?: string }>(request)
      .then((body) => remoteAgentHub.connectDevice(body))
      .then((device) => jsonResponse(response, 200, { code: 0, device, devices: remoteAgentHub.listDevices() }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/disconnect") {
    void readJsonBody<{ deviceId?: string }>(request)
      .then((body) => remoteAgentHub.disconnectDevice(String(body.deviceId || "")))
      .then((device) => jsonResponse(response, 200, { code: 0, device, devices: remoteAgentHub.listDevices() }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/remote-agent/tasks") {
    jsonResponse(response, 200, { code: 0, tasks: remoteAgentHub.listTasks(100) });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/tasks") {
    void readJsonBody<RemoteAgentTaskRequest>(request)
      .then((body) => remoteAgentHub.createTask(remoteAgentTaskWithGatewayDefaults(body)))
      .then((task) => jsonResponse(response, 202, { code: 0, task }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/remote-agent/task-events") {
    void readJsonBody<RemoteAgentTaskEvent>(request)
      .then((event) => remoteAgentHub.receiveTaskEvent(event))
      .then((task) => jsonResponse(response, 202, { code: 0, task }))
      .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
}

function handleRolePanelApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  activeRolesRoot = rolesRoot
): boolean {
  const messageListMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/role-panel\/messages$/);
  if (request.method === "GET" && messageListMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(messageListMatch[1]));
    if (!roleId) {
      jsonResponse(response, 400, { code: -1, message: "Missing role id." });
      return true;
    }
    const limit = Number(requestUrl.searchParams.get("limit") || "120");
    const roleDir = roleFolderPath(activeRolesRoot, roleId);
    jsonResponse(response, 200, {
      code: 0,
      roleId,
      messages: readRolePanelTimeline(roleDir, Number.isFinite(limit) && limit > 0 ? limit : 120)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/role-panel/messages") {
    void readJsonBody<RolePanelMessageRequest>(request)
      .then(async (body) => {
        const gatewayId = sanitizeRoleId(body.gatewayId);
        const runtime = gatewayId ? runtimes.get(gatewayId) : [...runtimes.values()][0];
        if (!runtime) throw new Error(gatewayId ? `Gateway not found: ${gatewayId}` : "No gateway is configured.");
        const text = String(body.text || "").trim();
        const attachments = normalizeRolePanelAttachments(body.attachments);
        if (!text && attachments.length === 0) throw new Error("Missing role panel message text or attachment.");
        const roleId = roleIdForDefinition(runtime.definition);
        const roleDir = roleDirForDefinition(runtime.definition);
        return deliverRolePanelMessage({
          runtime,
          roleId,
          roleDir,
          sender: "本地用户",
          text,
          attachments,
          messageIdPrefix: "role-panel-user",
          deliver: triggerGatewayRolePanelMessage
        });
      })
      .then((payload) => jsonResponse(response, 202, { code: 0, ...payload }))
      .catch((error) => jsonResponse(
        response,
        error instanceof RolePanelDeliveryError ? error.statusCode : 400,
        { code: -1, status: "failed", message: error instanceof Error ? error.message : String(error) }
      ));
    return true;
  }

  return false;
}

function speechServiceUrl(): string {
  return rabiGlobalConfig.read().rabiLinkRelay.speechServiceUrl;
}

function writeSpeechProxyResponse(response: http.ServerResponse, result: LocalSpeechResponse): void {
  response.writeHead(result.status, {
    "content-type": result.contentType,
    "content-length": String(result.body.byteLength),
    ...result.headers
  });
  response.end(result.body);
}

function writeSpeechJson<T>(
  response: http.ServerResponse,
  operation: Promise<T>,
  successStatus = 200,
  errorStatus = 502
): void {
  void operation
    .then(data => jsonResponse(response, successStatus, { code: 0, data }))
    .catch(error => jsonResponse(response, speechControlErrorStatus(error, errorStatus), {
      code: -1,
      message: speechControlErrorMessage(error)
    }));
}

function writeSpeechRuntimeJson(
  response: http.ServerResponse,
  operation: Promise<unknown>
): void {
  void operation
    .then(data => jsonResponse(response, 200, { code: 0, data }))
    .catch(error => jsonResponse(response, error instanceof SpeechRuntimeControlError ? error.status : 502, {
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof SpeechRuntimeControlError && error.detail ? { detail: error.detail } : {}),
      ...(error instanceof SpeechRuntimeControlError && error.resolution ? { resolution: error.resolution } : {})
    }));
}

async function inspectPlanFeedbackDelivery(
  request: PlanFeedbackRecoveryTaskRequest
): Promise<"accepted" | "in_progress" | "missing"> {
  const result = await handleAgentThreadRequest({
    action: "read",
    threadId: request.threadId,
    cwd: request.cwd,
    deliveryId: request.deliveryId
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || `Plan feedback readback failed with HTTP ${result.statusCode}.`));
  }
  const state = (result.data.delivery as { state?: unknown } | undefined)?.state;
  if (state === "accepted" || state === "in_progress" || state === "missing") return state;
  throw new Error("Plan feedback readback returned no authoritative delivery state.");
}

function queuePlanFeedbackRecoverySweep(reason: string, delayMs = PLAN_FEEDBACK_RECOVERY_RECHECK_MS): void {
  if (managerReadOnly || planFeedbackRecoveryTimer) return;
  planFeedbackRecoveryTimer = setTimeout(() => {
    planFeedbackRecoveryTimer = undefined;
    void runPlanFeedbackRecoverySweep(reason);
  }, Math.max(0, delayMs));
  planFeedbackRecoveryTimer.unref();
}

async function runPlanFeedbackRecoverySweep(reason: string): Promise<void> {
  if (managerReadOnly) return;
  let candidates: ReturnType<typeof listOpenPlanFeedbackRecoveryCandidates>;
  try {
    // Role data can be stored on a NAS. Keep its synchronous legacy scan out of
    // the Manager event loop so a slow share cannot stall every HTTP endpoint.
    candidates = await managerReadWorkerPool.queryPlanFeedbackRecoveryCandidates(rolesRoot);
  } catch (error) {
    managerOperationalLog.record("warn", "plan_feedback_recovery_scan_failed", {
      action: reason,
      error: managerOperationalError(error, rootDir),
      result: error instanceof ManagerReadWorkerError ? error.code : "failed"
    });
    queuePlanFeedbackRecoverySweep("recovery scan retry");
    return;
  }
  let delivered = 0;
  let scheduled = 0;
  let deferred = 0;
  let alreadyAttempted = 0;
  for (const candidate of candidates) {
    const recoveryKey = `${candidate.roleId}:${candidate.plan.id}:${candidate.feedback.id}`;
    if (attemptedPlanFeedbackRecoveries.has(recoveryKey)) {
      alreadyAttempted += 1;
      continue;
    }
    const outcome = await recoverPlanFeedbackCandidate(candidate, {
      inspect: inspectPlanFeedbackDelivery,
      schedule: async (current) => {
        attemptedPlanFeedbackRecoveries.add(recoveryKey);
        schedulePlanFeedbackDelivery(
          current.roleDir,
          current.roleId,
          String(current.feedback.gatewayId || "").trim(),
          current.plan,
          current.feedback
        );
      }
    });
    if (outcome.state === "delivered") {
      delivered += 1;
      publishManagerEvent("plan_feedback_changed", {
        roleId: candidate.roleId,
        planId: candidate.plan.id,
        feedbackId: outcome.record.id
      });
    } else if (outcome.state === "scheduled") {
      scheduled += 1;
    } else {
      deferred += 1;
    }
  }
  managerOperationalLog.record("info", "plan_feedback_recovery_sweep", {
    action: reason,
    result: `candidates=${candidates.length}; delivered=${delivered}; scheduled=${scheduled}; deferred=${deferred}; alreadyAttempted=${alreadyAttempted}`
  });
  if (deferred > 0) queuePlanFeedbackRecoverySweep("deferred delivery readback");
}

function writeSpeechModelManagerJson(
  response: http.ServerResponse,
  operation: () => unknown,
  successStatus = 200
): void {
  try {
    jsonResponse(response, successStatus, { code: 0, data: operation() });
  } catch (error) {
    jsonResponse(response, error instanceof SpeechModelManagerError ? error.status : 500, {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function handleSpeechApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/events") {
    proxySpeechEventStream(response, {
      openUpstream: signal => speechControl.eventStream(signal),
      errorMessage: speechControlErrorMessage
    });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/status") {
    writeSpeechJson(response, speechControl.status(), 200, 500);
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/runtime/start") {
    writeSpeechRuntimeJson(response, speechRuntimeControl.start());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/runtime/stop") {
    writeSpeechRuntimeJson(response, speechRuntimeControl.stop());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/model-management") {
    writeSpeechModelManagerJson(response, () => speechModelManager.snapshot());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/model-management/runtime/install") {
    writeSpeechModelManagerJson(response, () => speechModelManager.installRuntime(), 202);
    return true;
  }
  const modelInstallMatch = requestUrl.pathname.match(/^\/api\/speech\/model-management\/models\/([^/]+)\/install$/);
  if (request.method === "POST" && modelInstallMatch) {
    writeSpeechModelManagerJson(
      response,
      () => speechModelManager.installModel(decodeURIComponent(modelInstallMatch[1] || "")),
      202
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/selection-reader/settings") {
    jsonResponse(response, 200, { code: 0, data: selectionSpeechSettings.read() });
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/selection-reader/settings") {
    writeSpeechJson(
      response,
      readJsonBody<unknown>(request).then(body => selectionSpeechSettings.write(body)),
      200,
      500
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/models") {
    writeSpeechJson(response, speechControl.models().then(models => ({ models })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/personas") {
    jsonResponse(response, 200, { code: 0, data: { personas: speechControl.personas() } });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/speakers") {
    writeSpeechJson(response, speechControl.speakerRegistry(requestUrl.searchParams.get("sessionId") || undefined));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/speakers") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechSpeakerProfileCreateCommand>(request).then(body => speechControl.createSpeakerProfile(body)),
      200,
      400
    );
    return true;
  }
  if (requestUrl.pathname.startsWith("/api/speech/speakers/")) {
    const speakerId = requestUrl.pathname.slice("/api/speech/speakers/".length);
    if (request.method === "PATCH") {
      writeSpeechJson(
        response,
        readJsonBody<SpeechSpeakerProfileUpdateCommand>(request)
          .then(body => speechControl.updateSpeakerProfile(speakerId, body)),
        200,
        400
      );
      return true;
    }
    if (request.method === "DELETE") {
      writeSpeechJson(response, speechControl.deleteSpeakerProfile(speakerId), 200, 400);
      return true;
    }
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/speaker-bindings") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechSpeakerBindingCommand>(request).then(body => speechControl.bindSpeaker(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/speaker-identities") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechSpeakerIdentityCommand>(request).then(body => speechControl.identifySpeaker(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "DELETE" && requestUrl.pathname === "/api/speech/speaker-bindings") {
    writeSpeechJson(
      response,
      speechControl.unbindSpeaker(
        requestUrl.searchParams.get("sessionId") || "",
        requestUrl.searchParams.get("recordId") || "",
        requestUrl.searchParams.get("speakerLabel") || ""
      ),
      200,
      400
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/playback/status") {
    writeSpeechJson(response, speechControl.playbackStatus());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/audio-streams") {
    writeSpeechJson(response, speechControl.audioStreams().then(audioStream => ({ audioStream })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/audio-streams/events") {
    writeSpeechJson(response, speechControl.audioStreamEvents({
      limit: Number(requestUrl.searchParams.get("limit") || 200),
      clientId: requestUrl.searchParams.get("clientId") || undefined,
      sourceDeviceId: requestUrl.searchParams.get("sourceDeviceId") || undefined,
      beforeSequence: requestUrl.searchParams.has("beforeSequence")
        ? Number(requestUrl.searchParams.get("beforeSequence"))
        : undefined
    }).then(events => ({ events })));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/audio-streams/token") {
    writeSpeechJson(response, speechControl.audioStreamToken().then(token => ({ token })), 200, 409);
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/audio-streams/selection") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechAudioStreamSelectionCommand>(request)
        .then(body => speechControl.selectAudioStream(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/playback/volume") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechPlaybackVolumeCommand>(request).then(body => speechControl.setPlaybackVolume(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/records") {
    writeSpeechJson(response, speechControl.records({
      limit: Number(requestUrl.searchParams.get("limit") || 200),
      kind: requestUrl.searchParams.get("kind") || undefined,
      sessionId: requestUrl.searchParams.get("sessionId") || undefined,
      routeId: requestUrl.searchParams.get("routeId") || undefined,
      since: requestUrl.searchParams.has("since") ? Number(requestUrl.searchParams.get("since")) : undefined,
      until: requestUrl.searchParams.has("until") ? Number(requestUrl.searchParams.get("until")) : undefined,
      sourceDeviceId: requestUrl.searchParams.get("sourceDeviceId") || undefined,
      before: requestUrl.searchParams.has("before") ? Number(requestUrl.searchParams.get("before")) : undefined
    }).then(records => ({ records })));
    return true;
  }
  const speechRecordAudioMatch = requestUrl.pathname.match(/^\/api\/speech\/records\/([^/]+)\/audio$/);
  if (request.method === "GET" && speechRecordAudioMatch) {
    void speechControl.recordAudio(decodeURIComponent(speechRecordAudioMatch[1]))
      .then(result => writeSpeechProxyResponse(response, result))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error, 502), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/microphone/status") {
    writeSpeechJson(response, speechControl.microphoneStatus());
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/microphone/settings") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechMicrophoneSettingsCommand>(request).then(body => speechControl.updateMicrophoneSettings(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/microphone/reconcile") {
    writeSpeechJson(response, speechControl.reconcileMicrophone(), 200, 500);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/microphone/devices") {
    writeSpeechJson(response, speechControl.microphoneDevices().then(devices => ({ devices })));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/microphone/start") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechMicrophoneStartCommand>(request).then(body => speechControl.startMicrophone(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/microphone/stop") {
    writeSpeechJson(response, speechControl.stopMicrophone());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/playback/stop") {
    writeSpeechJson(response, speechControl.stopPlayback());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/tts") {
    void readJsonBody<SpeechSynthesisCommand>(request)
      .then(body => speechControl.synthesize(body))
      .then((result) => writeSpeechProxyResponse(response, result))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/asr") {
    const contentType = headerValue(request.headers["content-type"]);
    void readBodyBuffer(request, 27 * 1024 * 1024)
      .then(body => speechControl.transcribe(contentType, body))
      .then((result) => writeSpeechProxyResponse(response, result))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/messages") {
    const recordId = String(requestUrl.searchParams.get("recordId") || "").trim();
    if (recordId) {
      const record = speechIngressStore.read(recordId);
      if (!record) {
        jsonResponse(response, 404, { code: -1, message: `Speech ingress record was not found: ${recordId}` });
      } else {
        jsonResponse(response, 200, {
          code: 0,
          data: { record, deliveries: speechIngressStore.listDeliveryReceipts(record.id) }
        });
      }
      return true;
    }
    const limit = Math.max(1, Math.min(1_000, Math.floor(Number(requestUrl.searchParams.get("limit") || 200) || 200)));
    const sourceDeviceId = String(requestUrl.searchParams.get("sourceDeviceId") || "").trim();
    const messageAdapterType = requestUrl.searchParams.get("messageAdapterType") === "rabilink"
      ? "rabilink"
      : requestUrl.searchParams.get("messageAdapterType") === "speech"
        ? "speech"
        : undefined;
    const before = requestUrl.searchParams.has("before")
      ? Number(requestUrl.searchParams.get("before"))
      : undefined;
    const records = speechIngressStore.query({
      limit,
      sourceDeviceId: sourceDeviceId || undefined,
      messageAdapterType,
      before
    });
    jsonResponse(response, 200, {
      code: 0,
      data: {
        records,
        deliveriesByRecordId: Object.fromEntries(
          records.map(record => [record.id, speechIngressStore.listDeliveryReceipts(record.id)])
        )
      }
    });
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/messages") {
    void readJsonBody<SpeechMessageCommand & { gatewayId?: string }>(request)
      .then(
        body => {
          const host = rabiGlobalConfig.read();
          return speechControl.acceptMessage(hostOwnedSpeechMessageCommand(body, {
            rabiGuid: host.rabiGuid,
            rabiName: host.rabiName,
            fallbackHostName: os.hostname()
          }));
        },
        error => Promise.reject(new SpeechControlError(speechControlErrorMessage(error), 400))
      )
      .then(data => jsonResponse(response, 200, { code: 0, data }))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error, 502), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  return false;
}

function handleDesktopSettingsApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  if (requestUrl.pathname !== "/api/desktop/settings") return false;
  if (request.method === "GET") {
    jsonResponse(response, 200, { code: 0, data: desktopSettings.read() });
    return true;
  }
  if (request.method === "PATCH" || request.method === "PUT") {
    if (managerReadOnly) {
      jsonResponse(response, 403, { code: -1, message: "Manager is read-only." });
      return true;
    }
    void readJsonBody<Partial<DesktopSettings>>(request)
      .then((body) => {
        const current = desktopSettings.read();
        const screenshot = body && typeof body.screenshot === "object" && !Array.isArray(body.screenshot)
          ? body.screenshot
          : {};
        return desktopSettings.write({
          ...current,
          ...body,
          screenshot: { ...current.screenshot, ...screenshot }
        });
      })
      .then((data) => jsonResponse(response, 200, { code: 0, data }))
      .catch((error) => jsonResponse(response, 400, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }
  return false;
}

function roleDirForApi(roleId: string): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    throw new Error("Missing role id.");
  }
  return roleFolderPath(rolesRoot, safeRoleId);
}

function recalledKnowledgeForMessage(source: RegisterMessageGroupRequirementInput["source"]): KnowledgeRecallMatch[] {
  const roleId = String(source?.roleId || "").trim();
  if (!roleId) return [];
  try {
    return roleKnowledgeSnapshot(roleDirForApi(roleId), String(source.summary || ""), {
      roleId,
      archiveCompletedPlans: false,
      includePendingConsolidation: false
    }).requiredReadItems
      .filter((item): item is typeof item & { type: "plan" | "recent_memory" | "consolidated_memory" } =>
        item.type === "plan" || item.type === "recent_memory" || item.type === "consolidated_memory")
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        endpoint: item.endpoint,
        score: item.score,
        revisionAt: item.revisionAt
      }));
  } catch (error) {
    managerOperationalLog.record("warn", "message_knowledge_recall_failed", {
      action: roleId,
      error: managerOperationalError(error, rootDir)
    });
    return [];
  }
}

function wearableHealthMetrics(requestUrl: URL): WearableHealthMetric[] | undefined {
  const values = requestUrl.searchParams.getAll("metric")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is WearableHealthMetric => (
      value === "heart_rate"
      || value === "sleep_session"
      || value === "sleep_stage"
      || value === "sleep_state"
    ));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function handleWearableHealthApi(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  const route = parseWearableHealthResourceRoute(pathname);
  if (!route) return false;
  try {
    const roleDir = roleDirForApi(route.roleId);
    const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
    const sourceDeviceId = requestUrl.searchParams.get("sourceDeviceId")?.trim() || "";
    if (request.method === "GET" && route.resource === "config") {
      jsonResponse(response, 200, { code: 0, data: readWearableHealthConfig(roleDir) });
      return true;
    }
    if (request.method === "PATCH" && route.resource === "config") {
      void readJsonBody<{ defaultPolicy?: unknown; devices?: unknown }>(request)
        .then((body) => updateWearableHealthConfig(roleDir, body))
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "GET" && route.resource === "state") {
      jsonResponse(response, 200, { code: 0, data: currentWearableHealthState(roleDir, sourceDeviceId) });
      return true;
    }
    if (request.method === "GET" && route.resource === "history") {
      const limit = Number(requestUrl.searchParams.get("limit"));
      jsonResponse(response, 200, {
        code: 0,
        data: queryWearableHealthHistory(roleDir, {
          metrics: wearableHealthMetrics(requestUrl),
          sourceDeviceId,
          from: requestUrl.searchParams.get("from") || undefined,
          to: requestUrl.searchParams.get("to") || undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          order: requestUrl.searchParams.get("order") === "asc" ? "asc" : "desc"
        })
      });
      return true;
    }
    if (request.method === "GET" && route.resource === "summary") {
      const limit = Number(requestUrl.searchParams.get("limit"));
      jsonResponse(response, 200, {
        code: 0,
        data: summarizeWearableHealth(roleDir, {
          sourceDeviceId,
          from: requestUrl.searchParams.get("from") || undefined,
          to: requestUrl.searchParams.get("to") || undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
        })
      });
      return true;
    }
    if (request.method === "POST" && route.resource === "observations") {
      const deliverAlerts = ["1", "true", "yes"].includes(
        (requestUrl.searchParams.get("deliverAlerts") || "").trim().toLowerCase()
      );
      void readJsonBody<Record<string, unknown>>(request)
        .then(async (body) => {
          const nested = body.health && typeof body.health === "object" && !Array.isArray(body.health)
            ? body.health as Record<string, unknown>
            : {};
          const observation = {
            ...body,
            ...nested,
            policy: nested.policy ?? body.policy,
            samples: nested.samples ?? body.samples
          } as WearableHealthObservationInput;
          const data = ingestWearableHealthObservation(roleDir, observation);
          if (!deliverAlerts || data.alerts.length === 0) return data;
          const managerPort = request.socket.localPort || process.env.GATEWAY_MANAGER_PORT || "8790";
          const deliveries = [];
          for (const alert of data.alerts) {
            const sourceSample = alert.sample;
            const results = await deliverWearableAlert(route.roleId, alert, {
              agentRoleId: route.roleId,
              managerPort,
              sourceDeviceId: sourceSample?.sourceDeviceId || data.state.sourceDeviceId,
              sourceDeviceName: sourceSample?.sourceDeviceName,
              sourceDeviceKind: sourceSample?.sourceDeviceKind,
              transport: sourceSample?.transport || "manager-local"
            });
            deliveries.push({
              alertId: alert.id,
              results
            });
          }
          return { ...data, delivery: { requested: true, results: deliveries } };
        })
        .then((data) => jsonResponse(response, 202, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

function handleRoleKnowledgeApi(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  resolveRoleDir: (roleId: string) => string = roleDirForApi
): boolean {
  if (handleWearableHealthApi(request, pathname, response)) return true;
  if (handlePersonaVoiceTranscriptApi(
    request,
    new URL(request.url || pathname, "http://127.0.0.1"),
    response,
    { roleDir: resolveRoleDir }
  )) return true;
  const conversationSituationsMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/conversation-situations(?:\/([^/]+))?$/);
  if (conversationSituationsMatch) {
    const roleId = decodeURIComponent(conversationSituationsMatch[1]);
    const situationId = conversationSituationsMatch[2] ? decodeURIComponent(conversationSituationsMatch[2]) : "";
    try {
      const roleDir = resolveRoleDir(roleId);
      if (request.method !== "GET") {
        jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
        return true;
      }
      const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
      const situations = listConversationSituations(roleDir, Number(requestUrl.searchParams.get("limit") || 20));
      const data = situationId ? situations.find(item => item.id === situationId) : situations;
      if (situationId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Conversation situation not found: ${situationId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const identityObservationMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/identity-relations\/observations$/);
  if (identityObservationMatch) {
    const roleId = decodeURIComponent(identityObservationMatch[1]);
    if (request.method !== "POST") {
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    }
    try {
      const roleDir = resolveRoleDir(roleId);
      void readJsonBody<IdentityCandidateObservation>(request)
        .then(body => recordIdentityCandidateObservation(roleDir, body))
        .then(data => {
          publishManagerEvent("identity_relation_changed", {
            roleId,
            kind: "candidate_observation",
            recordId: data.participant.id
          });
          jsonResponse(response, data.appended ? 201 : 200, { code: 0, data });
        })
        .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const identityRelationsMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/identity-relations$/);
  if (identityRelationsMatch) {
    const roleId = decodeURIComponent(identityRelationsMatch[1]);
    try {
      const roleDir = resolveRoleDir(roleId);
      if (request.method === "GET") {
        const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
        const platform = requestUrl.searchParams.get("platform")?.trim() || "";
        const endpointIdentityNamespace = requestUrl.searchParams.get("endpointIdentityNamespace")?.trim() || "";
        const senderStableId = requestUrl.searchParams.get("senderStableId")?.trim() || "";
        if (platform || endpointIdentityNamespace || senderStableId) {
          if (!platform || !endpointIdentityNamespace || !senderStableId) {
            throw new Error("platform, endpointIdentityNamespace, and senderStableId must be provided together.");
          }
          jsonResponse(response, 200, {
            code: 0,
            data: {
              path: "identity-relations/events.jsonl",
              context: resolveIdentityRelationContext(roleDir, { platform, endpointIdentityNamespace, senderStableId,
                conversationKey: requestUrl.searchParams.get("conversationKey")?.trim() || undefined,
                projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined })
            }
          });
          return true;
        }
        jsonResponse(response, 200, {
          code: 0,
          data: {
            path: "identity-relations/events.jsonl",
            endpointAccounts: listIdentityEndpointAccounts(roleDir),
            participants: listIdentityParticipants(roleDir),
            relationCards: listIdentityRelationCards(roleDir)
          }
        });
        return true;
      }
      if (request.method === "PUT") {
        void readJsonBody<IdentityRelationPatch>(request)
          .then(body => ({ data: updateIdentityRelation(roleDir, body), kind: body.kind }))
          .then(({ data, kind }) => {
            publishManagerEvent("identity_relation_changed", { roleId, kind, recordId: data.record.id });
            jsonResponse(response, data.appended ? 201 : 200, { code: 0, data });
          })
          .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const voiceIdentityMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/voice-identities$/);
  if (voiceIdentityMatch) {
    try {
      const roleDir = resolveRoleDir(decodeURIComponent(voiceIdentityMatch[1]));
      if (request.method === "GET") {
        const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
        const sourceHostId = requestUrl.searchParams.get("sourceHostId")?.trim() || "";
        const voiceprintId = requestUrl.searchParams.get("voiceprintId")?.trim() || "";
        if (sourceHostId || voiceprintId) {
          if (!sourceHostId || !voiceprintId) throw new Error("sourceHostId and voiceprintId must be provided together.");
          const identity = findPersonaVoiceIdentity(roleDir, sourceHostId, voiceprintId);
          if (!identity) {
            jsonResponse(response, 404, { code: -1, message: "Persona voice identity was not found." });
            return true;
          }
          jsonResponse(response, 200, { code: 0, data: { path: "voice/voice-identities.jsonl", identity } });
          return true;
        }
        jsonResponse(response, 200, {
          code: 0,
          data: { path: "voice/voice-identities.jsonl", identities: listPersonaVoiceIdentities(roleDir) }
        });
        return true;
      }
      if (request.method === "PUT") {
        void readJsonBody<PersonaVoiceIdentityPatch>(request)
          .then(body => {
            if (typeof body.sourceHostId !== "string" || !body.sourceHostId.trim()) {
              throw new Error("sourceHostId must be a non-empty string.");
            }
            if (typeof body.voiceprintId !== "string" || !body.voiceprintId.trim()) {
              throw new Error("voiceprintId must be a non-empty string.");
            }
            if (Object.prototype.hasOwnProperty.call(body, "participantId")
              && body.participantId !== null
              && typeof body.participantId !== "string") {
              throw new Error("participantId must be a string, null, or omitted.");
            }
            const hasParticipantPatch = Object.prototype.hasOwnProperty.call(body, "participantId");
            const participantId = typeof body.participantId === "string" ? body.participantId.trim() : "";
            let participantStatus: "confirmed" | "corrected" = "confirmed";
            if (participantId) {
              const participant = listIdentityParticipants(roleDir).find(item => item.id === participantId);
              if (!participant || participant.conflicted || !["confirmed", "corrected"].includes(participant.status)) {
                throw new Error("participantId must reference a confirmed identity in the current persona.");
              }
              participantStatus = participant.status as "confirmed" | "corrected";
            }
            let identityRelationResult: ReturnType<typeof updateIdentityRelation> | undefined;
            if (hasParticipantPatch) {
              const sourceHostId = body.sourceHostId.trim();
              const voiceprintId = body.voiceprintId.trim();
              const endpointIdentityNamespace = `host:${sourceHostId}`;
              const existingAccount = listIdentityEndpointAccounts(roleDir).find(item =>
                item.platform === "voice"
                && item.endpointIdentityNamespace === endpointIdentityNamespace
                && item.senderStableId === voiceprintId
              );
              const retiredPreviousLinks = existingAccount?.participantLinks
                .filter(link => link.participantId !== participantId)
                .map(link => ({ ...link, status: "retired" as const })) ?? [];
              const participantLinks = participantId
                ? [
                    ...retiredPreviousLinks,
                    {
                      participantId,
                      status: participantStatus,
                      confidence: 1,
                      evidenceRefs: [{ note: "人格通过声纹确认界面显式关联到身份。" }]
                    }
                  ]
                : existingAccount?.participantLinks.map(link => ({ ...link, status: "retired" as const })) ?? [];
              if (participantId || existingAccount) {
                identityRelationResult = updateIdentityRelation(roleDir, {
                  kind: "endpoint_account",
                  platform: "voice",
                  endpointIdentityNamespace,
                  senderStableId: voiceprintId,
                  displayName: typeof body.displayName === "string" ? body.displayName.trim() : existingAccount?.displayName,
                  participantLinks
                });
              }
            }
            return { data: updatePersonaVoiceIdentity(roleDir, body), identityRelationResult };
          })
          .then(({ data, identityRelationResult }) => {
            if (identityRelationResult) {
              publishManagerEvent("identity_relation_changed", {
                roleId: decodeURIComponent(voiceIdentityMatch[1]),
                kind: "endpoint_account",
                recordId: identityRelationResult.record.id
              });
            }
            publishManagerEvent("persona_voice_identity_changed", {
              roleId: decodeURIComponent(voiceIdentityMatch[1]),
              appended: data.appended,
              deleted: data.deleted
            });
            jsonResponse(response, data.appended ? 201 : 200, { code: 0, data });
          })
          .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const validationMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/knowledge-validation$/);
  if (validationMatch) {
    const roleId = decodeURIComponent(validationMatch[1]);
    try {
      if (request.method !== "GET") {
        jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
        return true;
      }
      const roleDir = resolveRoleDir(roleId);
      jsonResponse(response, 200, { code: 0, data: validateRoleKnowledge(roleDir) });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const planFeedbackMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/plans\/([^/]+)\/feedback$/);
  if (planFeedbackMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(planFeedbackMatch[1]));
    const planId = decodeURIComponent(planFeedbackMatch[2]);
    try {
      if (!roleId) throw new Error("Missing role id.");
      const roleDir = resolveRoleDir(roleId);
      const plan = listPlans(roleDir).find((item) => item.id === planId);
      if (!plan) {
        jsonResponse(response, 404, { code: -1, message: `Plan not found: ${planId}` });
        return true;
      }
      if (request.method === "GET") {
        const records = listPlanFeedback(roleDir, planId);
        jsonResponse(response, 200, { code: 0, data: { count: records.length, latest: records[0], records } });
        return true;
      }
      if (request.method === "POST") {
        void readJsonBody<PlanFeedbackRequest>(request, PLAN_FEEDBACK_REQUEST_MAX_BYTES)
          .then(async (body) => {
            const feedbackKind = body.kind || "approval_suggestion";
            const planLevelFeedback = feedbackKind === "guidance" || feedbackKind === "guidance_response";
            if (feedbackKind === "guidance") {
              if (!planAcceptsGuidance(plan)) {
                throw new Error("Plan guidance is available only for running plans outside approval.");
              }
            }
            const requestedStepId = String(body.stepId || "").trim();
            if (planLevelFeedback && requestedStepId) {
              throw new Error("Plan guidance belongs to the plan and must not include a stepId.");
            }
            const step = planLevelFeedback
              ? undefined
              : requestedStepId
              ? plan.steps.find((item) => item.id === requestedStepId)
              : plan.steps.find((item) => item.id === plan.currentStepId)
                || plan.steps.find((item) => item.status === "进行中");
            if (requestedStepId && !step) throw new Error(`Plan step not found: ${requestedStepId}`);
            const baseCandidate = createPlanFeedbackRecord({
              id: body.feedbackId,
              roleId,
              planId,
              planTitle: plan.title,
              stepId: step?.id,
              stepTitle: step?.title,
              gatewayId: body.gatewayId,
              kind: body.kind,
              author: body.author,
              source: body.source,
              text: body.text,
              notifyAgent: body.notifyAgent
            });
            const existing = listPlanFeedback(roleDir, planId).find((item) => item.id === baseCandidate.id);
            if (existing && (existing.text !== baseCandidate.text || existing.stepId !== baseCandidate.stepId)) {
              throw new Error(`Feedback id already exists with different content: ${baseCandidate.id}`);
            }
            const attachments = body.attachments === undefined
              ? existing?.attachments || []
              : storePlanFeedbackAttachments(roleDir, baseCandidate.id, body.attachments, existing?.attachments);
            const mentionedPlanAttachments = resolvePlanFeedbackPlanAttachments(
              plan.attachments,
              body.planAttachmentIds,
              existing?.planAttachments
            ).map((attachment) => ({
              ...attachment,
              path: resolvePlanAttachmentFile(roleDir, plan.id, attachment)
            }));
            const candidate = { ...baseCandidate, attachments, planAttachments: mentionedPlanAttachments };
            if (existing && !planFeedbackAttachmentsEqual(existing.attachments, candidate.attachments)) {
              throw new Error(`Feedback id already exists with different attachments: ${candidate.id}`);
            }
            if (existing && !planFeedbackPlanAttachmentsEqual(existing.planAttachments, candidate.planAttachments)) {
              throw new Error(`Feedback id already exists with different plan attachment mentions: ${candidate.id}`);
            }
            const record = existing || appendPlanFeedback(roleDir, candidate);
            const qaResult = await consumePlanQaFeedback({
              roleDir,
              feedback: record,
              sendToTask: (request) => {
                const runtime = runtimeForRoleDelivery(
                  roleId,
                  String(record.gatewayId || body.gatewayId || "").trim()
                );
                return sendPlanQaFeedbackToTask({
                  ...request,
                  deliverySource: primaryAgentDeliverySource(runtime.definition)
                });
              }
            });
            if (qaResult.outcome !== "ignored") {
              const consumed = listPlanFeedback(roleDir, planId).find((item) => item.id === record.id) || record;
              publishManagerEvent("plan_feedback_changed", { roleId, planId, feedbackId: record.id });
              return consumed;
            }
            if (record.deliveryStatus === "record_only" || record.deliveryStatus === "delivered") {
              if (!existing) publishManagerEvent("plan_feedback_changed", { roleId, planId, feedbackId: record.id });
              return record;
            }
            return schedulePlanFeedbackDelivery(
              roleDir,
              roleId,
              String(body.gatewayId || record.gatewayId || "").trim(),
              plan,
              record
            );
          })
          .then((data) => jsonResponse(response, 202, { code: 0, data }))
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const consolidationResultMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/memory\/consolidation-runs\/([^/]+)\/result$/);
  if (consolidationResultMatch) {
    const roleId = decodeURIComponent(consolidationResultMatch[1]);
    const runId = decodeURIComponent(consolidationResultMatch[2]);
    try {
      const roleDir = resolveRoleDir(roleId);
      if (request.method === "POST") {
        void readJsonBody<Record<string, unknown>>(request)
          .then((body) => applyMemoryConsolidationResult(roleDir, runId, body))
          .then((data) => {
            memoryConsolidationScheduler?.noteRunCompleted(runId);
            memoryConsolidationScheduler?.reschedule();
            publishManagerEvent("memory_consolidation_changed", { roleId, runId, status: "completed" });
            jsonResponse(response, 200, { code: 0, data });
          })
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const route = parseRoleKnowledgeResourceRoute(pathname);
  if (!route) {
    return false;
  }

  const { roleId, resource, itemId } = route;

  try {
    const roleDir = resolveRoleDir(roleId);
    if (request.method === "GET" && resource === "plans") {
      const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
      const wantsPage = !itemId && requestUrl.searchParams.has("limit");
      const wantsSummary = wantsPage && requestUrl.searchParams.get("detail") === "summary";
      if (itemId) {
        const plan = getPlan(roleDir, itemId);
        if (!plan) {
          jsonResponse(response, 404, { code: -1, message: `Plan not found: ${itemId}` });
          return true;
        }
        jsonResponse(response, 200, { code: 0, data: presentedPlanWithFeedback(roleDir, plan) });
        return true;
      }
      void listPlansAsync(roleDir)
        .then((plans) => {
          const data = wantsPage
            ? (() => {
              const requestedView = requestUrl.searchParams.get("view")?.trim() || undefined;
              if (requestedView && !["current", "plans", "archived"].includes(requestedView)) {
                throw new Error("Invalid plan page view.");
              }
              const requestedSort = requestUrl.searchParams.get("sort")?.trim() || "status";
              if (!["status", "updated", "importance", "urgency"].includes(requestedSort)) {
                throw new Error("Invalid plan page sort.");
              }
              const page = paginateRolePlans(
                presentPlans(plans),
                requestUrl.searchParams.get("cursor")?.trim() || "",
                normalizeRolePlanPageLimit(requestUrl.searchParams.get("limit")),
                {
                  view: requestedView,
                  query: requestUrl.searchParams.get("query") || "",
                  sort: requestedSort as "status" | "updated" | "importance" | "urgency",
                  statuses: requestUrl.searchParams.getAll("status").map((value) => value.trim()).filter(Boolean),
                  tags: requestUrl.searchParams.getAll("tag").map((value) => value.trim()).filter(Boolean),
                  includeFacets: requestUrl.searchParams.get("facets") !== "0"
                }
              );
              return {
                ...page,
                items: page.items.map((plan) => wantsSummary
                  ? summarizeRolePlan(plan)
                  : {
                    ...plan,
                    approval: planFeedbackSummary(roleDir, plan.id)
                  })
              };
            })()
            : presentPlans(plans).map((plan) => ({
              ...plan,
              approval: planFeedbackSummary(roleDir, plan.id)
            }));
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, 400, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "GET" && resource === "skills") {
      const data = itemId ? getRoleSkill(roleDir, itemId) : listRoleSkills(roleDir);
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Skill not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "GET" && resource === "memory" && !itemId) {
      const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
      if (requestUrl.searchParams.get("counts") === "1") {
        void managerReadWorkerPool.queryRoleMemoryCounts(roleDir)
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return true;
      }
      if (requestUrl.searchParams.has("limit")) {
        const kind = requestUrl.searchParams.get("kind")?.trim() || "recent";
        if (kind !== "recent" && kind !== "consolidated" && kind !== "archived") {
          throw new Error("Invalid memory page kind.");
        }
        void managerReadWorkerPool.queryRoleMemoryPage(roleDir, {
          kind,
          cursor: requestUrl.searchParams.get("cursor")?.trim() || "",
          limit: normalizeRoleMemoryPageLimit(requestUrl.searchParams.get("limit")),
          query: requestUrl.searchParams.get("query") || ""
        })
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return true;
      }
      void managerReadWorkerPool.queryRoleMemoryOverview(roleDir)
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "POST" && resource === "plans" && !itemId) {
      void readJsonBody<Record<string, unknown>>(request, PLAN_ATTACHMENT_REQUEST_MAX_BYTES)
        .then((body) => createPlan(roleDir, body))
        .then((data) => jsonResponse(response, 201, { code: 0, data: presentedPlanWithFeedback(roleDir, data) }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "PATCH" && resource === "plans" && itemId) {
      void readJsonBody<Record<string, unknown>>(request, PLAN_ATTACHMENT_REQUEST_MAX_BYTES)
        .then((body) => updatePlan(roleDir, itemId, body))
        .then((data) => jsonResponse(response, 200, { code: 0, data: presentedPlanWithFeedback(roleDir, data) }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "GET" && resource === "memory/recent") {
      void managerReadWorkerPool.queryRoleMemoryCatalog(roleDir, "recent", itemId)
        .then((data) => {
          if (itemId && !data) {
            jsonResponse(response, 404, { code: -1, message: `Memory not found: ${itemId}` });
            return;
          }
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "GET" && resource === "memory/consolidated") {
      void managerReadWorkerPool.queryRoleMemoryCatalog(roleDir, "consolidated", itemId)
        .then((data) => {
          if (itemId && !data) {
            jsonResponse(response, 404, { code: -1, message: `Consolidated memory not found: ${itemId}` });
            return;
          }
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "POST" && resource === "memory/recent" && !itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => createRecentMemory(roleDir, body))
        .then((data) => {
          memoryConsolidationScheduler?.reschedule();
          jsonResponse(response, 201, {
            code: 0,
            data: presentRoleMemories(roleDir, listRecentMemories(roleDir), "recent").find((item) => item.id === data.id)
              ?? presentRoleMemory(data, "recent")
          });
        })
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "PATCH" && resource === "memory/recent" && itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => updateRecentMemory(roleDir, itemId, body))
        .then((data) => {
          memoryConsolidationScheduler?.reschedule();
          jsonResponse(response, 200, {
            code: 0,
            data: presentRoleMemories(roleDir, listRecentMemories(roleDir), "recent").find((item) => item.id === data.id)
              ?? presentRoleMemory(data, "recent")
          });
        })
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "GET" && resource === "memory/consolidation-runs") {
      const runs = listConsolidationRuns(roleDir);
      const data = itemId ? runs.find((item) => item.id === itemId) : runs;
      if (itemId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Consolidation run not found: ${itemId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    }
    if (request.method === "POST" && resource === "memory/consolidation-requests" && !itemId) {
      void readJsonBody<Record<string, unknown>>(request)
        .then((body) => pendingMemoryConsolidation(
          roleDir,
          body.triggerSource === "auto" ? "auto" : "api",
          typeof body.includeOlderThanHours === "number" ? body.includeOlderThanHours : undefined,
          typeof body.triggerOlderThanHours === "number" ? body.triggerOlderThanHours : undefined,
          body.force === true
        ))
        .then((data) => {
          if (!data) {
            jsonResponse(response, 409, { code: -1, message: "No memory consolidation is due." });
            return;
          }
          jsonResponse(response, 201, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

async function forwardFenneNoteRequest(
  body: unknown,
  targetUrl: string,
  token: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "RabiRoute"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const forwarded = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {})
  });
  const text = await forwarded.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return {
    ok: forwarded.ok,
    status: forwarded.status,
    target: targetUrl,
    response: data
  };
}

async function forwardPlaybackRequest(body: unknown): Promise<Record<string, unknown>> {
  return forwardFenneNoteRequest(body, fenneNotePlaybackUrl, fenneNotePlaybackToken);
}

async function forwardFenneNoteReply(body: unknown): Promise<Record<string, unknown>> {
  return forwardFenneNoteRequest(body, fenneNoteReplyUrl, fenneNoteReplyToken);
}

function standaloneGatewayPayload(
  includeDiagnostics = true,
  includeConfigDefinitions = includeDiagnostics
): Record<string, unknown> {
  return measureSyncPerformanceOperation(
    includeDiagnostics
      ? PERFORMANCE_OPERATIONS.managerGatewaysBuildDiagnostics
      : PERFORMANCE_OPERATIONS.managerGatewaysBuildSummary,
    () => {
      const roleInfoCatalogCache = new Map<string, Array<Record<string, unknown>>>();
      const tailCache: JsonlTailCache = new Map();
      return buildStandaloneGatewayPayload(
        {
          runtimes: runtimes.values(),
          runtimeStatus: includeDiagnostics
            ? (runtime) => runtimeStatusWithRoleInfoCache(runtime, roleInfoCatalogCache, tailCache)
            : (runtime) => runtimeSummaryStatusWithRoleInfoCache(runtime, roleInfoCatalogCache),
          routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
          rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
        },
        { includeConfigDefinitions }
      );
    }
  );
}

function localIpv4AddressEntries(): Array<{ name: string; address: string; cidr?: string }> {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({
        name,
        address: address.address,
        cidr: address.cidr || undefined
      })))
    .sort((left, right) => lanAddressPriority(left.name, left.address) - lanAddressPriority(right.name, right.address)
      || left.name.localeCompare(right.name)
      || left.address.localeCompare(right.address));
}

function networkOptionsPayload(): Record<string, unknown> {
  const localAddresses = localIpv4AddressEntries();
  const adapters = {
    napcat: {
      httpServers: [],
      websocketClients: []
    },
    webhook: {
      listeners: []
    },
    heartbeat: {},
    disabled: {}
  };
  return {
    code: 0,
    data: {
      adapters,
      localAddresses,
      httpServers: [],
      websocketClients: []
    }
  };
}

type WebguiLanAccessPatch = {
  enabled?: boolean;
  regenerateToken?: boolean;
};

function publicWebguiLanAccessPayload(request: http.IncomingMessage): Record<string, unknown> {
  const config = rabiGlobalConfig.read().webguiLan;
  const addresses = localIpv4AddressEntries();
  const canManage = isLocalMachineRemoteAddress(request.socket.remoteAddress, addresses.map(item => item.address));
  const listeningOnLan = managerListensOnLan(managerHost);
  const restartRequired = !managerHostOverride && config.enabled !== listeningOnLan;
  const token = canManage ? config.accessToken : "";
  const urls = addresses.map(({ name, address, cidr }) => ({
    name,
    address,
    cidr,
    url: token
      ? `http://${address}:${managerPort}/#/overview?webgui_token=${encodeURIComponent(token)}`
      : `http://${address}:${managerPort}/#/overview`
  }));
  return {
    code: 0,
    data: {
      enabled: config.enabled,
      tokenConfigured: Boolean(config.accessToken),
      token,
      canManage,
      managerHost,
      managerPort,
      listeningOnLan,
      restartRequired,
      hostManagedByEnvironment: Boolean(managerHostOverride),
      urls
    }
  };
}

function handleWebguiLanAccessApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse
): boolean {
  if (requestUrl.pathname !== "/api/webgui-access") return false;
  if (request.method === "GET") {
    jsonResponse(response, 200, publicWebguiLanAccessPayload(request));
    return true;
  }
  if (request.method !== "PATCH" && request.method !== "POST") {
    jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
    return true;
  }
  if (!isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address))) {
    jsonResponse(response, 403, {
      code: -1,
      message: "局域网 WebGUI 的开关和访问密钥只能在运行 Manager 的 Rabi PC 本机管理。"
    });
    return true;
  }
  void readJsonBody<WebguiLanAccessPatch>(request)
    .then((body) => {
      const current = rabiGlobalConfig.read().webguiLan;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
      const accessToken = body.regenerateToken === true || (enabled && !current.accessToken)
        ? generateWebguiAccessToken()
        : current.accessToken;
      rabiGlobalConfig.patch({ webguiLan: { enabled, accessToken } });
      return publicWebguiLanAccessPayload(request);
    })
    .then((payload) => jsonResponse(response, 200, payload))
    .catch((error) => jsonResponse(response, 400, {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    }));
  return true;
}

function metaPayload(): Record<string, unknown> {
  const version = rabiRoutePackageVersion();
  const globalConfig = rabiGlobalConfig.read();
  return {
    version,
    health: {
      state: "healthy",
      scope: "manager_control_plane",
      checkedAt: new Date().toISOString(),
      pid: process.pid,
      message: "Manager 控制面可响应；消息入口健康在独立层级报告。"
    },
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    managerPort,
    managerAutostart: managerShouldAutostart,
    rabiGuid: globalConfig.rabiGuid,
    rabiName: globalConfig.rabiName,
    webguiLan: {
      enabled: globalConfig.webguiLan.enabled,
      tokenConfigured: Boolean(globalConfig.webguiLan.accessToken),
      listeningOnLan: managerListensOnLan(managerHost),
      restartRequired: !managerHostOverride && globalConfig.webguiLan.enabled !== managerListensOnLan(managerHost)
    },
    rabiLinkRelay: publicRabiLinkRelayConfig(rabiLinkRelayConfigForMeta()),
    rabiLinkRelayRuntime: rabiLinkRelayRuntime.status(),
    managerRuntime: managerRuntimeDiagnosticsSummary(),
    performance: performanceMonitoring.store.status(),
    messageProcessingPersistence: messageProcessingBoardPersistence.status(),
    readWorkers: managerReadWorkerPool.status(),
    catalogWorkers: managerCatalogWorkerPool.status(),
    agentScanWorkers: managerAgentScanWorkerPool.status(),
    performanceWorkers: managerPerformanceWorkerPool.status(),
    httpLimits: managerHttpLimits,
    personaSyncLan: personaSyncLanServer.status(),
    computerName: os.hostname()
  };
}

async function prewarmRolePlanCatalogs(): Promise<void> {
  const startedAt = Date.now();
  let roleDirectories: string[] = [];
  try {
    const entries = await fs.promises.readdir(rolesRoot, { withFileTypes: true });
    roleDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rolesRoot, entry.name));
    const results = await Promise.allSettled(roleDirectories.map((roleDir) => listPlansAsync(roleDir)));
    managerOperationalLog.record("info", "role_plan_catalogs_prewarmed", {
      durationMs: Date.now() - startedAt,
      result: `roles=${roleDirectories.length}; fulfilled=${results.filter((result) => result.status === "fulfilled").length}`
    });
  } catch (error) {
    managerOperationalLog.record("warn", "role_plan_catalogs_prewarm_failed", {
      durationMs: Date.now() - startedAt,
      result: `roles=${roleDirectories.length}`,
      error: managerOperationalError(error, rootDir)
    });
  }
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function staticWebuiResponse(pathname: string, response: http.ServerResponse): boolean {
  const indexPath = path.join(webuiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) {
    return false;
  }

  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
  const candidatePath = path.resolve(webuiDistPath, normalized);
  const relativeToDist = path.relative(webuiDistPath, candidatePath);
  if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
    return false;
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    response.writeHead(200, { "content-type": contentTypeFor(candidatePath) });
    response.end(fs.readFileSync(candidatePath));
    return true;
  }

  if (path.extname(candidatePath)) {
    return false;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fs.readFileSync(indexPath, "utf8"));
  return true;
}

function htmlResponse(pathname: string, response: http.ServerResponse): void {
  if (staticWebuiResponse(pathname, response)) {
    return;
  }

  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end("RabiRoute WebGUI build is missing. Run `npm run webgui:build` or `npm run build`.");
}

function assetResponse(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/);
  if (!match) {
    return false;
  }

  const assetPath = path.join(rootDir, "assets", match[1]);
  if (!fs.existsSync(assetPath)) {
    return false;
  }

  const extension = path.extname(assetPath).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".svg"
      ? "image/svg+xml; charset=utf-8"
      : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType });
  response.end(fs.readFileSync(assetPath));
  return true;
}

function handleAction(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/(start|stop|restart|delete)$/);
  if (!match) {
    return false;
  }

  const [, encodedId, action] = match;
  const id = decodeURIComponent(encodedId);
  try {
    if (action === "start") {
      startGateway(id);
    } else if (action === "stop") {
      stopGateway(id);
    } else if (action === "restart") {
      stopGateway(id);
      setTimeout(() => startGateway(id), 1000);
    } else {
      removeGatewayConfig(id);
      loadRuntimes();
      syncRunningGateways();
      jsonResponse(response, 200, standaloneGatewayPayload());
      return true;
    }
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }

  jsonResponse(response, 200, { code: 0, message: `requested ${action}`, data: [...runtimes.values()].map(runtimeStatus) });
  return true;
}

function handleWeixinLoginAction(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/weixin-login$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const runtime = runtimes.get(id);
  if (!runtime) {
    jsonResponse(response, 404, { code: -1, message: `Gateway not found: ${id}` });
    return true;
  }
  if (!sharedGatewayAdapterTypes(runtime.definition).includes("weixin")) {
    jsonResponse(response, 400, { code: -1, message: "该 Route 未启用个人微信消息端。" });
    return true;
  }
  try {
    requestWeixinLogin(dataDirFor(runtime.definition));
    jsonResponse(response, 202, {
      code: 0,
      message: "已明确请求生成个人微信登录二维码；不会发送消息或修改账号配置。"
    });
  } catch (error) {
    jsonResponse(response, 500, {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return true;
}

function handleTriggerAction(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/manual-trigger$/);
  if (!match) {
    return false;
  }

  const [, id] = match;
  void readJsonBody<ManualTriggerRequest>(request)
    .then((body) => {
      const result = triggerGatewayManualRule(decodeURIComponent(id), body);
      jsonResponse(response, 202, {
        code: 0,
        message: result.alreadyRunning ? "manual trigger already running" : "manual trigger accepted",
        data: result
      });
    })
    .catch((error) => {
      jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  return true;
}

function handleDeliveryReplayAction(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  const match = requestUrl.pathname.match(/^\/gateways\/([^/]+)\/delivery-replay$/);
  if (!match) {
    return false;
  }

  const id = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    try {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "50") || 50;
      const status = requestUrl.searchParams.get("status");
      jsonResponse(response, 200, { code: 0, ...listGatewayDeliveryReplayAttempts(id, limit, status) });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "POST") {
    void readJsonBody<DeliveryReplayRequest>(request)
      .then((body) => replayGatewayDelivery(id, body))
      .then(() => {
        jsonResponse(response, 202, { code: 0, message: "delivery replay requested", data: [...runtimes.values()].map(runtimeStatus) });
      })
      .catch((error) => {
        jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}

function handleAgentStateReport(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  if (pathname !== "/api/agent-state") {
    return false;
  }

  void readJsonBody<AgentStateReportRequest>(request)
    .then((body) => {
      const gatewayId = sanitizeRoleId(body.gatewayId);
      const adapterType = parseAgentAdapterType(body.adapterType);
      const runtime = gatewayId ? runtimes.get(gatewayId) : undefined;
      if (!gatewayId || !adapterType || !runtime) {
        throw new Error("Invalid agent state report target.");
      }
      const generation = typeof body.generation === "string" ? body.generation.trim() : "";
      const sequence = Number(body.sequence);
      const previous = agentStateByGateway.get(gatewayId) ?? {};
      const previousSequence = Number(previous[adapterType]?.reportSequence ?? 0);
      const reportDecision = agentStateReportDecision(
        runtime.agentStateGeneration,
        generation,
        sequence,
        previousSequence
      );
      if (reportDecision === "invalid-generation") {
        throw new Error("Stale or invalid agent state report generation.");
      }
      if (reportDecision === "out-of-order") {
        jsonResponse(response, 202, { code: 0, ignored: true });
        return;
      }
      previous[adapterType] = {
        ...(previous[adapterType] ?? {}),
        ...(body.state ?? {}),
        agentAdapterType: adapterType,
        reportGeneration: generation,
        reportSequence: sequence,
        updatedAt: new Date().toISOString()
      };
      agentStateByGateway.set(gatewayId, previous);
      if (adapterType === "codex") {
        const bindingUpdate = resolveReportedCodexBindingUpdate(runtime.definition, body.state ?? {});
        if (bindingUpdate) {
          runtime.definition.codexThreadId = bindingUpdate.threadId;
          runtime.definition.codexCwd = bindingUpdate.workspace;
          writeAdapterConfigFile(runtime.definition);
          publishManagerEvent("codex_binding_replaced", {
            gatewayId,
            previousThreadId: String(body.state?.bindingPreviousThreadId || ""),
            threadId: bindingUpdate.threadId,
            workspace: bindingUpdate.workspace
          });
        }
      }
      jsonResponse(response, 200, { code: 0 });
    })
    .catch((error) => {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  return true;
}

export type ManagerPersonaDomainApiContext = {
  rolesRoot?: string;
  roleDir?: (roleId: string) => string;
};

export function handleManagerEventApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/events") return false;
  openManagerEventStream(request, response);
  return true;
}

export function handleManagerPersonaDomainApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: ManagerPersonaDomainApiContext = {}
): boolean {
  const activeRolesRoot = context.rolesRoot ?? rolesRoot;
  const resolveRoleDir = context.roleDir ?? roleDirForApi;
  if (handlePersonaMessagingApi(request, requestUrl, response, {
    rootDir,
    rolesRoot: activeRolesRoot,
    catalog: personaCatalog,
    runtimes: () => [...runtimes.values()],
    authorizeSource: (routeId, personaId, capability) => currentPersonaMessageAuthority().verify(routeId, personaId, capability),
    deliver: triggerGatewayRolePanelMessage
  })) return true;
  if (handlePersonaAvatarApi(request, requestUrl.pathname, response, activeRolesRoot, change => {
    // This is presentation metadata only: version plus a Manager-relative URL, never a role directory path.
    publishManagerEvent("persona_avatar_changed", change);
  })) return true;
  if (handlePersonaDocumentApi(request, requestUrl, response, resolveRoleDir)) return true;
  if (handlePlanAgentStatusApi(request, requestUrl, response, { roleDir: resolveRoleDir })) return true;
  if (handlePlanAttachmentApi(request, requestUrl.pathname, response, resolveRoleDir)) return true;
  if (handleRolePanelApi(request, requestUrl, response, activeRolesRoot)) return true;
  if (handleDesktopSettingsApi(request, requestUrl, response)) return true;
  if (handleSpeechApi(request, requestUrl, response)) return true;
  return handleRoleKnowledgeApi(request, requestUrl.pathname, response, resolveRoleDir);
}

export async function startManager(): Promise<void> {
  if (!managerReadOnly) {
    await performanceMonitoring.start().catch((error) => {
      managerOperationalLog.record("warn", "performance_monitor_start_failed", {
        error: managerOperationalError(error, rootDir)
      });
    });
  }
  // Built-artifact acceptance is a control-plane liveness/read-boundary check.
  // Do not let a transient NAS route scan delay the isolated Manager listener;
  // normal installed runtime still loads and owns its configured Routes.
  if (!managerReadOnly) loadRuntimes();
  if (!managerReadOnly) memoryConsolidationScheduler = createMemoryConsolidationScheduler();
  personaSyncAutoReconciler?.start();
  void personaSyncService.startManifestIndex()
    .catch(error => console.warn(`Persona sync manifest index unavailable; queries will reconcile on demand: ${error instanceof Error ? error.message : String(error)}`));
  if (managerShouldAutostart) {
    for (const runtime of runtimes.values()) {
      if (runtime.definition.enabled) {
        startGateway(runtime.definition.id);
      }
    }
  }
  if (managerReadOnly) {
    console.log("Manager read-only mode enabled: startup reconciliation and mutating HTTP methods are disabled.");
  } else {
    reconcileSpeechMicrophone("manager startup");
  }
  const unsubscribeMessageProcessingPlanUpdates = managerReadOnly
    ? undefined
    : subscribePlanUpdates((event) => { void handleMessageProcessingPlanUpdate(event.roleDir, event.after); });
  if (!managerReadOnly) {
    for (const requirement of messageProcessingBoard.list({ limit: 500 })) scheduleKnowledgeCallbackReminder(requirement);
    refreshAgentRequestReminderTimers();
  }

  const server = http.createServer((request, response) => {
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    const method = request.method ?? "UNKNOWN";
    let pathname = "/";
    managerRequestContexts.set(response, {
      requestId,
      method,
      pathname: () => pathname,
      startedAt: requestStartedAt
    });
    response.setHeader("x-rabiroute-request-id", requestId);
    response.once("finish", () => {
      const durationMs = Math.max(0, Date.now() - requestStartedAt);
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
      const failed = response.statusCode >= 400;
      const slow = durationMs >= 2_000;
      const context = managerRequestContexts.get(response);
      performanceMonitoring.recordHttpRequest(
        pathname,
        response.statusCode,
        durationMs,
        requestId,
        context?.responseBytes
      );
      if (!mutating && !failed && !slow) return;
      managerOperationalLog.record(failed ? "warn" : slow ? "warn" : "info", "http_request_completed", {
        requestId,
        method,
        pathname,
        statusCode: response.statusCode,
        durationMs,
        result: failed ? "failed" : "completed"
      });
    });
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      pathname = requestUrl.pathname;
      if (!webguiLanRequestAllowed(request, requestUrl)) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("www-authenticate", "Bearer realm=\"RabiRoute WebGUI\"");
        jsonResponse(response, 401, {
          code: -1,
          error: "WEBGUI_TOKEN_REQUIRED",
          message: "局域网访问需要有效的 RabiRoute WebGUI 访问密钥。请使用控制台生成的完整访问链接。"
        });
        return;
      }
      if (managerReadOnly && !managerReadOnlyRequestAllowed(request.method)) {
        jsonResponse(response, 423, {
          code: -1,
          message: "Manager is running in read-only acceptance mode."
        });
        return;
      }
      if (bilibiliHistoryBridge.handle(request, requestUrl, response)) {
        return;
      }
      if (handleWebguiLanAccessApi(request, requestUrl, response)) {
        return;
      }
      if (performanceApi.handle(request, requestUrl, response)) {
        return;
      }
      if (handleManagerEventApi(request, requestUrl, response)) {
        return;
      }
      if (request.method === "GET" && assetResponse(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleAction(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleWeixinLoginAction(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleTriggerAction(request, requestUrl.pathname, response)) {
        return;
      }
      if ((request.method === "GET" || request.method === "POST") && handleDeliveryReplayAction(request, requestUrl, response)) {
        return;
      }
      if (request.method === "POST" && handleAgentStateReport(request, requestUrl.pathname, response)) {
        return;
      }
      if (handleCodexHookApi(request, requestUrl, response, codexHookContextService)) {
        return;
      }
      if (handleLanguageStyleApi(request, requestUrl, response, languageStyleValidator)) {
        return;
      }
      if (handlePersonaSyncApi(request, requestUrl, response, personaSyncRouteContext(true))) {
        return;
      }
      if (handleRabiApi(request, requestUrl, response, {
        rootDir,
        routeRoot,
        managerPort,
        managerHost,
        version: rabiRoutePackageVersion,
        globalConfig: rabiGlobalConfig,
        runtimes: () => runtimes.values(),
        runtimeStatus,
        readConfig,
        writeConfig,
        loadRuntimes,
        syncRunningGateways,
        syncRabiLinkRelay: syncRabiLinkRelayRuntime,
        agentManagerApiCtx
      })) {
        return;
      }
      if (handleRemoteAgentApi(request, requestUrl, response)) {
        return;
      }
      if (handleManagerPersonaDomainApi(request, requestUrl, response)) {
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/gateways") {
        jsonResponse(response, 200, standaloneGatewayPayload(
          gatewayPayloadIncludesDiagnostics(requestUrl.searchParams),
          gatewayPayloadIncludesConfigDefinitions(requestUrl.searchParams)
        ));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/gateways") {
        void readJsonBody<GatewayConfigFile>(request)
          .then((body) => {
            writeConfig(body);
            loadRuntimes();
            syncRunningGateways();
            jsonResponse(response, 200, standaloneGatewayPayload());
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/network-options") {
        jsonResponse(response, 200, networkOptionsPayload());
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/manager-config") {
        jsonResponse(response, 200, {
          code: 0,
          routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
          rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager-config") {
        void readJsonBody<ManagerConfig>(request)
          .then((body) => {
            const cfg = readManagerConfig();
            if (body.routeDir !== undefined) cfg.routeDir = body.routeDir || undefined;
            if (body.rolesDir !== undefined) cfg.rolesDir = body.rolesDir || undefined;
            writeManagerConfig(cfg);
            ensureDataDirs();
            jsonResponse(response, 200, { code: 0, routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"), rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/") });
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/meta") {
        jsonResponse(response, 200, measureSyncPerformanceOperation(
          PERFORMANCE_OPERATIONS.managerMetaBuild,
          metaPayload
        ));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/scan/message-adapters") {
        void Promise.resolve()
          .then(async () => {
            const gatewayId = requestUrl.searchParams.get("gatewayId") || undefined;
            const [adapterScan, napcatScan] = await Promise.all([
              messageAdapterScanPayload(),
              napcatScanHealthPayload()
            ]);
            const health = summarizeIndependentAdapterHealth({
              adapters: adapterScan.adapters,
              napcatHealth: napcatScan.payload
            });
            for (const [type, adapterHealth] of Object.entries(health.adapters)) {
              const adapter = adapterScan.adapters[type as Exclude<MessageAdapterType, "disabled">];
              if (adapter) adapter.health = adapterHealth;
            }
            return {
              adapters: adapterScan.adapters,
              health,
              scan: {
                requestedGatewayId: gatewayId,
                partial: adapterScan.partial || napcatScan.partial,
                durationMs: Math.max(adapterScan.durationMs, napcatScan.durationMs),
                deadlineMs: Math.max(adapterScan.deadlineMs, napcatScan.deadlineMs),
                adapters: adapterScan.diagnostics,
                napcatInstances: napcatScan.diagnostics
              },
              repair: {
                changed: false,
                messages: ["本轮扫描只读取状态；未启动进程、未修改配置、未触发登录或修复。"]
              },
              napcatHealth: napcatScan.payload,
              gatewayPayload: standaloneGatewayPayload()
            };
          })
          .then((payload) => {
            jsonResponse(response, 200, payload);
          })
          .catch((error) => {
            jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "POST" && (requestUrl.pathname === "/api/playback/request" || requestUrl.pathname === "/api/fennenote/playback")) {
        void readJsonBody<unknown>(request)
          .then((body) => forwardPlaybackRequest(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 202 : 502, result);
          })
          .catch((error) => {
            jsonResponse(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), target: fenneNotePlaybackUrl });
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/fennenote/reply") {
        void readJsonBody<unknown>(request)
          .then((body) => forwardFenneNoteReply(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 202 : 502, result);
          })
          .catch((error) => {
            jsonResponse(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), target: fenneNoteReplyUrl });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/message-processing/board") {
        const routeId = requestUrl.searchParams.get("routeId")?.trim() || undefined;
        const limit = Number(requestUrl.searchParams.get("limit") || "100");
        void messageProcessingBoardPayload(routeId, limit)
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const messageProcessingRequirementMatch = requestUrl.pathname.match(/^\/api\/message-processing\/requirements\/([^/]+)$/);
      if (request.method === "GET" && messageProcessingRequirementMatch) {
        const requirementId = decodeURIComponent(messageProcessingRequirementMatch[1]);
        const requirement = messageProcessingBoard.getRequirement(requirementId);
        if (!requirement) {
          jsonResponse(response, 404, { code: -1, message: `Message processing requirement not found: ${requirementId}` });
          return;
        }
        jsonResponse(response, 200, { code: 0, data: requirement });
        return;
      }
      const messageProcessingSendContextMatch = requestUrl.pathname.match(/^\/api\/message-processing\/requirements\/([^/]+)\/send-context$/);
      if (request.method === "GET" && messageProcessingSendContextMatch) {
        const requirementId = decodeURIComponent(messageProcessingSendContextMatch[1]);
        const sourceMessageId = requestUrl.searchParams.get("sourceMessageId")?.trim() || undefined;
        try {
          const data = messageProcessingSendContextReview.snapshot(requirementId, sourceMessageId);
          jsonResponse(response, 200, { code: 0, data });
        } catch (error) {
          jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (request.method === "POST" && messageProcessingSendContextMatch) {
        const requirementId = decodeURIComponent(messageProcessingSendContextMatch[1]);
        void readJsonBody<MessageProcessingSendContextApprovalInput>(request)
          .then((body) => messageProcessingSendContextReview.approve(requirementId, body))
          .then((data) => {
            managerOperationalLog.record("info", "message_processing_send_context_review_approved", {
              action: requirementId,
              result: `expiresAt=${data.expiresAt}`
            });
            jsonResponse(response, 200, { code: 0, data });
          })
          .catch((error) => jsonResponse(response, 400, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/message-processing/requirements") {
        void readJsonBody<{
          action?: "register_group" | "dispatch" | "dispatch_failed";
          requirementId?: string;
          messageGroupId?: string;
          source?: RegisterMessageGroupRequirementInput["source"];
          worker?: MessageProcessingRequirement["worker"];
          error?: string;
        }>(request)
          .then((body) => {
            const requirementId = String(body.requirementId || "").trim();
            if (!requirementId) throw new Error("Missing requirementId.");
            const item = body.action === "register_group"
              ? messageProcessingBoard.registerMessageGroup({
                  requirementId,
                  messageGroupId: String(body.messageGroupId || "").trim(),
                  source: body.source as RegisterMessageGroupRequirementInput["source"],
                  knowledgeMatches: recalledKnowledgeForMessage(body.source as RegisterMessageGroupRequirementInput["source"])
                })
              : body.action === "dispatch"
                ? messageProcessingBoard.recordDispatch(requirementId, body.worker as NonNullable<MessageProcessingRequirement["worker"]>)
                : body.action === "dispatch_failed"
                  ? messageProcessingBoard.recordDispatchFailure(requirementId, body.error || "Message Agent dispatch failed.")
                  : (() => { throw new Error("Unsupported message-processing action."); })();
            scheduleKnowledgeCallbackReminder(item);
            publishManagerEvent("message_processing_board_changed", { requirementId: item.id, status: item.status });
            return item;
          })
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const messageProcessingOutcomeMatch = requestUrl.pathname.match(/^\/api\/message-processing\/requirements\/([^/]+)\/outcome$/);
      if (request.method === "POST" && messageProcessingOutcomeMatch) {
        const requirementId = decodeURIComponent(messageProcessingOutcomeMatch[1]);
        void readJsonBody<MessageProcessingOutcomeInput>(request)
          .then((body) => {
            const requirement = messageProcessingBoard.getRequirement(requirementId);
            const roleId = String(body.roleId || requirement?.source.roleId || "").trim();
            const assessedRequirement = requirement && body.projectFactAssessment?.status === "critical"
              ? { ...requirement, criticalFacts: body.projectFactAssessment.facts }
              : requirement;
            for (const disposition of body.knowledgeMatchDispositions || []) {
              for (const action of disposition.actions || []) {
                if (!action.recordType || !action.recordId || !action.verifiedAt) continue;
                verifyCriticalProjectFactRecord({
                  workspaceRoot: rootDir,
                  roleDir: roleId ? roleDirForApi(roleId) : undefined,
                  requirement: requirement ? { ...requirement, criticalFacts: [{ kind: "scope", evidence: action.evidence }] } : requirement,
                  disposition: {
                    status: "recorded",
                    record: action.recordType === "memory"
                      ? { type: "memory", memoryId: action.recordId }
                      : { type: "plan", planId: action.recordId },
                    evidence: action.evidence,
                    verifiedAt: action.verifiedAt
                  }
                });
              }
            }
            verifyCriticalProjectFactRecord({
              workspaceRoot: rootDir,
              roleDir: roleId ? roleDirForApi(roleId) : undefined,
              requirement: assessedRequirement,
              disposition: body.criticalFactDisposition
            });
            return { body, data: messageProcessingBoard.submitOutcome(requirementId, body) };
          })
          .then(({ body, data }) => {
            setMessageProcessingPlanBaseline(data, body.roleId, body.planId);
            scheduleKnowledgeCallbackReminder(data);
            publishManagerEvent("message_processing_board_changed", { requirementId: data.id, status: data.status });
            jsonResponse(response, 200, { code: 0, data });
          })
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const knowledgeCallbackMatch = requestUrl.pathname.match(/^\/api\/message-processing\/requirements\/([^/]+)\/knowledge-callback$/);
      if (request.method === "POST" && knowledgeCallbackMatch) {
        const requirementId = decodeURIComponent(knowledgeCallbackMatch[1]);
        void readJsonBody<KnowledgeMatchCallbackInput>(request)
          .then((body) => {
            const requirement = messageProcessingBoard.getRequirement(requirementId);
            if (!requirement) throw new Error(`Message processing requirement not found: ${requirementId}`);
            const roleId = String(requirement.source.roleId || "").trim();
            if ((body.result === "updated" || body.result === "created") && body.recordType && body.recordId) {
              verifyCriticalProjectFactRecord({
                workspaceRoot: rootDir,
                roleDir: roleId ? roleDirForApi(roleId) : undefined,
                requirement: { ...requirement, criticalFacts: [{ kind: "scope", evidence: body.evidence }] },
                disposition: {
                  status: "recorded",
                  record: body.recordType === "memory"
                    ? { type: "memory", memoryId: body.recordId }
                    : { type: "plan", planId: body.recordId },
                  evidence: body.evidence,
                  verifiedAt: body.verifiedAt
                }
              });
            }
            return messageProcessingBoard.recordKnowledgeCallback(requirementId, body);
          })
          .then((data) => {
            scheduleKnowledgeCallbackReminder(data);
            publishManagerEvent("message_processing_board_changed", { requirementId: data.id, status: data.status });
            jsonResponse(response, 200, { code: 0, data });
          })
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/agent/requests") {
        const status = requestUrl.searchParams.get("status")?.trim();
        const requests = agentRequests.list().filter((item) => !status || item.status === status);
        jsonResponse(response, 200, { code: 0, data: { requests } });
        return;
      }
      const agentRequestMatch = requestUrl.pathname.match(/^\/api\/agent\/requests\/([^/]+)$/);
      if (request.method === "GET" && agentRequestMatch) {
        const requestId = decodeURIComponent(agentRequestMatch[1]);
        const item = agentRequests.get(requestId);
        if (!item) {
          jsonResponse(response, 404, { code: -1, message: `Agent request not found: ${requestId}` });
          return;
        }
        jsonResponse(response, 200, { code: 0, data: item });
        return;
      }
      const agentRequestCancelMatch = requestUrl.pathname.match(/^\/api\/agent\/requests\/([^/]+)\/cancel$/);
      if (request.method === "POST" && agentRequestCancelMatch) {
        const requestId = decodeURIComponent(agentRequestCancelMatch[1]);
        void readJsonBody<{ reason?: string }>(request)
          .then((body) => agentRequests.cancel(requestId, body.reason))
          .then((data) => {
            refreshAgentRequestReminderTimers();
            publishManagerEvent("agent_requests_changed", { requestId: data.id, status: data.status });
            jsonResponse(response, 200, { code: 0, data });
          })
          .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (requestUrl.pathname === "/api/agent/threads" && (request.method === "GET" || request.method === "POST")) {
        const requestBody = request.method === "GET"
          ? Promise.resolve<AgentThreadRequest>({
              action: "list",
              query: requestUrl.searchParams.get("query") ?? "",
              limit: Number(requestUrl.searchParams.get("limit") ?? "100"),
              offset: Number(requestUrl.searchParams.get("offset") ?? "0")
            })
          : readJsonBody<AgentThreadRequest>(request);
        void requestBody
          .then(async (body) => {
            const managedBody = applyManagedAgentThreadDefaults(body);
            try {
              const result = await handleAgentThreadRequest(managedBody, {
                allowedWorkspaces: agentThreadAllowedWorkspaces(),
                defaultWorkspace: rootDir,
                agentRequests,
                onMessageProcessingHandoff: (event) => {
                  const item = messageProcessingBoard.submitOutcome(event.requirementId, {
                    decision: "handoff",
                    decidedByThreadId: event.sourceThreadId,
                    targetAgentType: event.targetAgentType,
                    targetThreadId: event.targetThreadId,
                    planId: event.planId,
                    planTitle: event.planTitle
                  });
                  setMessageProcessingPlanBaseline(item, item.source.roleId, event.planId);
                  publishManagerEvent("message_processing_board_changed", { requirementId: item.id, status: item.status });
                }
              });
              const communication = result.data.communication && typeof result.data.communication === "object"
                ? result.data.communication as Record<string, unknown>
                : undefined;
              const repliedRequestId = String(communication?.inReplyToRequestId || "").trim();
              let handoffReturnWarning = "";
              if (repliedRequestId) {
                const repliedRequest = agentRequests.get(repliedRequestId);
                if (repliedRequest?.status === "responded" && repliedRequest.messageProcessingRequirementId) {
                  try {
                    const item = messageProcessingBoard.recordHandoffReturned(
                      repliedRequest.messageProcessingRequirementId,
                      repliedRequest.target.threadId
                    );
                    publishManagerEvent("message_processing_board_changed", { requirementId: item.id, status: item.status });
                  } catch (error) {
                    handoffReturnWarning = `Agent response was accepted, but the message-processing publisher could not be resumed: ${error instanceof Error ? error.message : String(error)}`;
                    managerOperationalLog.record("warn", "agent_response_handoff_return_failed", {
                      result: "tracking_failed",
                      requestId: repliedRequestId,
                      action: repliedRequest.messageProcessingRequirementId,
                      error: managerOperationalError(error, rootDir)
                    });
                  }
                }
              }
              refreshAgentRequestReminderTimers();
              if (communication) publishManagerEvent("agent_requests_changed", communication);
              if (handoffReturnWarning) {
                result.data.ok = false;
                result.data.status = "delivered_tracking_failed";
                result.data.warning = [String(result.data.warning || "").trim(), handoffReturnWarning].filter(Boolean).join(" ");
                result.data.handoffReturn = {
                  status: "tracking_failed",
                  error: {
                    stage: "message_processing_return_tracking",
                    message: handoffReturnWarning,
                    retryable: true
                  }
                };
              }
              jsonResponse(response, result.statusCode, {
                code: result.data.ok === false ? -1 : 0,
                ...result.data
              });
            } catch (error) {
              jsonResponse(response, 400, { code: -1, ...agentThreadRequestFailureData(error, managedBody) });
            }
          })
          .catch((error) => {
            jsonResponse(response, 400, {
              code: -1,
              status: "failed",
              message: error instanceof Error ? error.message : String(error),
              error: {
                stage: "request_body",
                message: error instanceof Error ? error.message : String(error),
                retryable: false
              }
            });
          });
        return;
      }
      const agentSendReceiptMatch = requestUrl.pathname.match(/^\/api\/agent\/send\/receipts\/([^/]+)$/);
      if (request.method === "GET" && agentSendReceiptMatch) {
        const receipt = agentSendReceiptResponse(rootDir, decodeURIComponent(agentSendReceiptMatch[1]));
        jsonResponse(response, receipt.statusCode, { code: receipt.statusCode < 400 ? 0 : -1, ...receipt.body });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/agent/send/traces") {
        try {
          const matches = findAgentSendTraces(rootDir, {
            channel: requestUrl.searchParams.get("channel"),
            sentMessageId: requestUrl.searchParams.get("sentMessageId"),
            routeId: requestUrl.searchParams.get("routeId")
          });
          jsonResponse(response, 200, { code: 0, data: { matches } });
        } catch (error) {
          jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/agent/send") {
        void readJsonBody<AgentSendRequest>(request)
          .then(async (body) => {
            const receiptBeforeValidation = readAgentSendReceipt(rootDir, String(body.deliveryId || ""));
            const validatedSendContext = !receiptBeforeValidation
              ? messageProcessingSendContextReview.validateSend(body)
              : undefined;
            let reviewedReplySource: ReviewedReplySourceEvidence | undefined;
            if (validatedSendContext?.sourceMessageId) {
              const prepared = prepareAgentSendRequest(body);
              if (prepared.channel === "napcat" && prepared.target.target === "group") {
                const roleId = String(validatedSendContext.requirement.source.roleId || "").trim();
                if (!roleId) {
                  throw new Error(`Cannot recover reviewed source ${validatedSendContext.sourceMessageId}: requirement has no roleId.`);
                }
                const recovered = recoverReviewedMessageProcessingSourceRecord(
                  roleDirForApi(roleId),
                  validatedSendContext.requirement,
                  validatedSendContext.sourceMessageId,
                  {
                    expectedGroupId: String(prepared.target.groupId || ""),
                    expectedInstanceId: String(prepared.target.instanceId || "")
                  }
                );
                reviewedReplySource = {
                  routeId: recovered.routeId,
                  sourceMessageId: recovered.sourceMessageId,
                  groupId: recovered.groupId,
                  instanceId: recovered.instanceId,
                  record: recovered.record,
                  dataDirs: [recovered.roleDir],
                  reviewedAttachmentIds: recovered.reviewedAttachmentIds
                };
              }
            }
            const replyOptions = {
              rootDir,
              routeRoot,
              rolesRoot,
              speechServiceUrl: speechServiceUrl(),
              publishEvent: publishManagerEvent,
              runtimes: [...runtimes.values()].map((runtime) => {
                const relay = rabiLinkRelayConfigFor(runtime.definition);
                return {
                  ...runtime.definition,
                  rabiLinkRelay: relay,
                  napcatInstances: (runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)).map((instance) => ({
                    ...instance,
                    accessToken: instance.accessToken ?? ""
                  }))
                };
              })
            };
            if (!receiptBeforeValidation) {
              validateAgentSendReplyImageDescriptions(body, replyOptions, reviewedReplySource);
            }
            const existingReceipt = readAgentSendReceipt(rootDir, String(body.deliveryId || ""));
            let languageStyleValidation: AgentSendResult["languageStyleValidation"];
            if (!existingReceipt) {
              const styleDecision = await evaluateAgentSendLanguageStyle(body, replyOptions, languageStyleValidator);
              languageStyleValidation = styleDecision.metadata;
              if (styleDecision.blocked) {
                const prepared = prepareAgentSendRequest(body);
                jsonResponse(response, 409, {
                  code: -1,
                  ok: false,
                  status: "style_confirmation_required",
                  reason: "Language style validation failed. Review the reasons, then resend the same deliveryId with styleValidation=0 only after confirming the text is intentional.",
                  deliveryId: prepared.deliveryId,
                  sender: prepared.sender,
                  channel: prepared.channel,
                  routeId: prepared.routeId,
                  target: prepared.target,
                  languageStyleValidation
                });
                return null;
              }
            }
            const deliver = async () => ({
              ...await handleAgentSend(body, replyOptions, reviewedReplySource),
              ...(languageStyleValidation ? { languageStyleValidation } : {})
            });
            const result = await executeIdempotentAgentSend(body, {
              rootDir,
              deliver,
              recover: async () => {
                const inspection = await inspectAgentSendDelivery(body, replyOptions);
                if (inspection.state === "completed") return inspection;
                if (inspection.state === "missing") return { state: "retry" };
                return { state: "uncertain", reason: inspection.reason };
              }
            });
            if (result.body.replyImageDescriptionArchive && result.body.idempotency.duplicate === false) {
              managerOperationalLog.record("info", "agent_reply_image_descriptions_archived", {
                action: String(body.deliveryId || ""),
                result: `sourceMessageId=${result.body.replyImageDescriptionArchive.sourceMessageId}; files=${result.body.replyImageDescriptionArchive.files.length}`
              });
            }
            recordMessageProcessingSend(body, result.body);
            return result;
          })
          .then((result) => {
            if (!result) return;
            jsonResponse(response, result.statusCode, { code: result.body.ok ? 0 : -1, ...result.body });
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, ok: false, status: "blocked", message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/open-config-file") {
        jsonResponse(response, 200, openConfigFilePayload(
          requestUrl.searchParams.get("type"),
          requestUrl.searchParams.get("gatewayId"),
          requestUrl.searchParams.get("roleId")
        ));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager/start") {
        jsonResponse(response, 200, { code: 0, message: "manager is already running" });
        return;
      }
      if (handleDesktopLifecycleApi(request, requestUrl, response, { rootDir, shutdownManager })) {
        return;
      }
      if (requestUrl.pathname === "/api/gateways") {
        jsonResponse(response, 200, measureSyncPerformanceOperation(
          PERFORMANCE_OPERATIONS.managerGatewaysBuildDiagnostics,
          () => {
            const roleInfoCatalogCache = new Map<string, Array<Record<string, unknown>>>();
            const tailCache: JsonlTailCache = new Map();
            return [...runtimes.values()]
              .map((runtime) => runtimeStatusWithRoleInfoCache(runtime, roleInfoCatalogCache, tailCache));
          }
        ));
        return;
      }
      if (requestUrl.pathname === "/api/scan/agents" && request.method === "GET") {
        const codexLimit = Number(requestUrl.searchParams.get("codexLimit") || "200");
        const codexOffset = Number(requestUrl.searchParams.get("codexOffset") || "0");
        const codexQuery = requestUrl.searchParams.get("codexQuery") || undefined;
        const runtimeSnapshots = [...runtimes.values()].map((runtime) => ({ definition: runtime.definition }));
        void managerAgentScanWorkerPool.queryAgentScan<Record<string, unknown>>(
          rootDir,
          runtimeSnapshots,
          { codexLimit, codexOffset, codexQuery }
        )
          .then((data) => {
            const operations = Array.isArray(data.__performanceOperations)
              ? data.__performanceOperations as Array<{ operation?: unknown; durationMs?: unknown; error?: unknown }>
              : [];
            for (const operation of operations) {
              recordPerformanceOperation(
                String(operation.operation || "manager.agent_scan.unknown"),
                Number(operation.durationMs || 0),
                operation.error === true
              );
            }
            const responseData = { ...data };
            delete responseData.__performanceOperations;
            jsonResponse(response, 200, responseData);
          })
          .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return;
      }
      if (requestUrl.pathname === "/api/agent/copilot-install" && request.method === "POST") {
        void (async () => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          try {
            const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "@github/copilot"], {
              shell: true,
              timeout: 120_000,
              env: { ...process.env }
            });
            jsonResponse(response, 200, { ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
          } catch (err: unknown) {
            const e = err as { message?: string; stdout?: string; stderr?: string };
            jsonResponse(response, 500, { ok: false, error: e.message, stderr: e.stderr });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/copilot-login" && request.method === "POST") {
        void (async () => {
          const { spawn } = await import("node:child_process");
          try {
            // Find copilot bin
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileAsync = promisify(execFile);
            let copilotBin = "copilot";
            try {
              const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["copilot"], { timeout: 2000 });
              const first = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
              if (first) copilotBin = first;
            } catch { /* use default */ }

            // Spawn copilot login, capture device code from stdout
            const child = spawn(copilotBin, ["login"], {
              env: { ...process.env },
              shell: process.platform === "win32",
              windowsHide: true
            });

            let output = "";
            let code: string | null = null;
            let url: string | null = null;

            const codeTimer = setTimeout(() => {
              if (!code) {
                child.kill();
                jsonResponse(response, 408, { ok: false, error: "Timeout waiting for device code" });
              }
            }, 15_000);

            child.stdout?.on("data", (d: Buffer) => {
              output += d.toString();
              const codeMatch = output.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
              const urlMatch = output.match(/https:\/\/github\.com\/login\/device/);
              if (codeMatch && !code) {
                code = codeMatch[1];
                url = urlMatch ? "https://github.com/login/device" : null;
                clearTimeout(codeTimer);
                jsonResponse(response, 200, { ok: true, code, url, pid: child.pid });
              }
            });

            child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

            child.on("exit", (exitCode) => {
              clearTimeout(codeTimer);
              publishManagerEvent("copilot_login_status", {
                done: exitCode === 0,
                exitCode,
                error: exitCode === 0 ? "" : output.trim()
              });
              if (exitCode === 0 && !code) {
                jsonResponse(response, 200, { ok: true, done: true });
              } else if (exitCode !== 0 && !code) {
                jsonResponse(response, 500, { ok: false, error: output.trim() });
              }
            });
          } catch (err: unknown) {
            jsonResponse(response, 500, { ok: false, error: String(err) });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/copilot-status" && request.method === "GET") {
        void (async () => {
          jsonResponse(response, 200, await getCopilotStatus(agentManagerApiCtx()));
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/astrbot-login-test" && request.method === "POST") {
        void readJsonBody<AstrbotLoginTestRequest>(request)
          .then((body) => testAstrbotLoginEndpoint(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-repair-all" && request.method === "POST") {
        void (async () => {
          const scanRepair = repairGatewayConfigsForScan();
          const ctx = napcatManagerCtx();
          const results: Array<Record<string, unknown>> = [];
          for (const runtime of runtimes.values()) {
            if (!definitionUsesNapcat(runtime.definition)) continue;
            for (const instance of runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)) {
              const health = await testNapcatHealthEndpoint(ctx, {
                httpUrl: instance.httpUrl,
                webuiUrl: instance.webuiUrl,
                accessToken: instance.accessToken,
                webuiToken: instance.webuiToken,
                gatewayPort: instance.gatewayPort
              });
              if (health.fixAvailable) {
                try {
                  const fixed = await configureNapcatOneBot(ctx, {
                    httpUrl: instance.httpUrl,
                    webuiUrl: instance.webuiUrl,
                    accessToken: instance.accessToken,
                    webuiToken: instance.webuiToken,
                    gatewayPort: instance.gatewayPort
                  });
                  results.push({ gatewayId: runtime.definition.id, instanceId: instance.id, ok: true, action: "configure-onebot", ...fixed });
                } catch (error) {
                  results.push({ gatewayId: runtime.definition.id, instanceId: instance.id, ok: false, action: "configure-onebot", message: error instanceof Error ? error.message : String(error) });
                }
              } else {
                results.push({ gatewayId: runtime.definition.id, instanceId: instance.id, ok: Boolean(health.ok), action: "health-check", message: health.ok ? "已连通，无需修复。" : String(health.message || "没有可自动修复项。") });
              }
            }
          }
          jsonResponse(response, 200, {
            ok: true,
            repair: scanRepair,
            results,
            napcatHealth: (await napcatScanHealthPayload()).payload,
            gatewayPayload: standaloneGatewayPayload()
          });
        })().catch((error) => {
          jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
        });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-ensure-ready" && request.method === "POST") {
        void readJsonBody<NapcatLaunchRequest>(request)
          .then((body) => ensureNapcatInstanceReady(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, 200, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-health" && request.method === "POST") {
        void (async () => {
          const body = await readJsonBody<NapcatHealthRequest>(request);
          let result = await testNapcatHealthEndpoint(napcatManagerCtx(), body) as Record<string, unknown>;
          const correctedWebuiUrl = correctedNapcatWebuiUrlFromHealth(result);
          if (correctedWebuiUrl) {
            const runtime = body.gatewayId
              ? runtimes.get(body.gatewayId)
              : [...runtimes.values()].find((item) => {
                  const instances = item.definition.napcatInstances ?? normalizeNapCatInstances(item.definition);
                  return instances.some((instance) =>
                    (body.instanceId && instance.id === body.instanceId)
                    || (body.httpUrl && instance.httpUrl === body.httpUrl)
                    || (body.webuiUrl && instance.webuiUrl === body.webuiUrl)
                  );
                });
            const instances = runtime ? runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition) : [];
            const instance = runtime
              ? instances.find((item) => item.id === body.instanceId)
                ?? instances.find((item) => body.httpUrl && item.httpUrl === body.httpUrl)
                ?? instances.find((item) => body.webuiUrl && item.webuiUrl === body.webuiUrl)
              : undefined;
            if (runtime && instance) {
              const backfilled = backfillNapcatInstanceWebuiUrl(runtime.definition, instance.id, correctedWebuiUrl);
              if (backfilled) {
                instance.webuiUrl = backfilled;
                result = addHealthDiagnostic(result, `已根据 NapCat webui.json 自动修正 WebUI 地址：${backfilled}`);
              }
            }
          }
          jsonResponse(response, 200, result);
        })().catch((error) => {
          jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
        });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-configure-onebot" && request.method === "POST") {
        void readJsonBody<NapcatHealthRequest>(request)
          .then((body) => configureNapcatOneBot(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-add" && request.method === "POST") {
        void readJsonBody<NapcatAddRequest>(request)
          .then((body) => addManagedNapcatInstance(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-launch" && request.method === "POST") {
        void readJsonBody<NapcatLaunchRequest>(request)
          .then((body) => launchNapcatInstanceEndpoint(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, result.ok !== false ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-restart" && request.method === "POST") {
        void readJsonBody<NapcatLaunchRequest>(request)
          .then((body) => restartNapcatInstanceEndpoint(napcatManagerCtx(), body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-remove" && request.method === "POST") {
        void readJsonBody<NapcatRemoveRequest>(request)
          .then((body) => removeManagedNapcatInstance(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/agent/marvis-open" && request.method === "POST") {
        void readJsonBody<MarvisOpenRequest>(request)
          .then((body) => {
            jsonResponse(response, 200, openMarvis(agentManagerApiCtx(), body));
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/deploy-astrbot-adapter" && request.method === "POST") {
        void (async () => {
          try {
            const result = await deployAstrbotAdapter(agentManagerApiCtx());
            jsonResponse(response, result.status, result.body);
          } catch (err: unknown) {
            jsonResponse(response, 500, { ok: false, error: String(err) });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/reload") {
        loadRuntimes();
        syncRunningGateways();
        if (request.headers.accept?.includes("application/json")) {
          jsonResponse(response, 200, { ok: true, gateways: [...runtimes.values()].map(runtimeStatus) });
        } else {
          response.writeHead(303, { location: "/" });
          response.end();
        }
        return;
      }
      htmlResponse(requestUrl.pathname, response);
    } catch (error) {
      managerOperationalLog.record("error", "http_request_exception", {
        requestId,
        method,
        pathname,
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        result: "exception",
        error: managerOperationalError(error, rootDir)
      });
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  remoteAgentHub.attach(server);
  server.requestTimeout = managerHttpLimits.requestTimeoutMs;
  server.headersTimeout = managerHttpLimits.headersTimeoutMs;
  server.keepAliveTimeout = managerHttpLimits.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = managerHttpLimits.maxRequestsPerSocket;
  if (managerShouldAutostart && remoteAgentDiscoverable) {
    remoteAgentHub.startDiscoveryResponder();
  } else if (!managerShouldAutostart) {
    console.log("Remote Agent LAN discovery responder disabled by RABIROUTE_MANAGER_AUTOSTART=0");
  } else {
    console.log("Remote Agent LAN discovery responder disabled by REMOTE_AGENT_DISCOVERABLE=0");
  }

  server.listen(managerPort, managerHost, () => {
    console.log(`gateway-manager listening on http://${managerHost}:${managerPort}`);
    console.log(`roles: ${rolesRoot}`);
    console.log(`route: ${routeRoot}`);
    managerOperationalLog.record("info", "manager_listening", {
      result: `host=${managerHost}; port=${managerPort}; readOnly=${managerReadOnly}`
    });
    syncRabiLinkRelayRuntime();
    memoryConsolidationScheduler?.start();
    setImmediate(() => { void prewarmRolePlanCatalogs(); });
    setImmediate(() => { void runPlanFeedbackRecoverySweep("manager startup"); });
    if (managerShouldAutostart) {
      setImmediate(() => {
        void autoLoginNapcatInstancesOnRabiStart(napcatManagerCtx())
          .catch(error => console.warn(`NapCat startup auto login failed: ${error instanceof Error ? error.message : String(error)}`));
      });
    }
  });

  const configWatcher = managerShouldAutostart && managerConfigWatcherEnabled() ? startConfigWatcher() : null;
  if (!configWatcher) {
    console.log("Route config event watcher disabled by RABIROUTE_MANAGER_AUTOSTART=0");
  }

  let shuttingDown = false;

  function shutdownManager(reason: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`gateway-manager shutting down: ${reason}`);
    managerOperationalLog.record("info", "manager_shutdown_requested", { result: reason });
    unsubscribeMessageProcessingPlanUpdates?.();
    for (const timer of knowledgeCallbackReminderTimers.values()) clearTimeout(timer);
    knowledgeCallbackReminderTimers.clear();
    for (const timer of agentRequestReminderTimers.values()) clearTimeout(timer);
    agentRequestReminderTimers.clear();
    if (planFeedbackRecoveryTimer) clearTimeout(planFeedbackRecoveryTimer);
    planFeedbackRecoveryTimer = undefined;
    memoryConsolidationScheduler?.stop();
    configWatcher?.close();
    personaSyncAutoReconciler?.stop();
    personaSyncService.stopManifestIndex();
    personaSyncLanServer.stop();
    rabiLinkRelayRuntime.stop();
    speechModelManager.stop();
    performanceApi.close();
    stopAllGateways();
    server.close(() => {
      void Promise.allSettled([
        messageProcessingBoardPersistence.flush(),
        managerOperationalLog.flush(),
        performanceMonitoring.stop()
      ]).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  }

  process.on("SIGINT", () => shutdownManager("SIGINT"));
  process.on("SIGTERM", () => shutdownManager("SIGTERM"));
}

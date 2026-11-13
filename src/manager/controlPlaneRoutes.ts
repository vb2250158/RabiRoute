import { createManagerTransportIdentity } from "./managerTransportIdentity.js";
import { assertComputerFeaturePolicyEnabled } from "../shared/agentInteractiveProtocol.js";
import {createComputerSettingsDefinition, type ComputerSettingsDefinition} from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import type { ComputerPresentationTheme } from "../../apps/rabi-agent/lib/computer-service.mjs";
import { computerAgentSourceId, endComputerTrackingForPlan } from "./computerTaskLifecycle.js";
import { resolvePluginPackageRoots } from "../shared/pluginPackageRoots.js";
import { WebSocketServer } from "ws";
import { TunnelRtc } from "../peerTunnel/rtc.js";
import { websocketChannel, connectWebsocket } from "../peerTunnel/channel.js";
import { PEER_TRANSPORT_PRIORITY } from "../shared/peerTunnelContract.js";
import { joinChildProcess } from "../runtime/joinedChildProcess.js";
import { MessageEndpointManagers } from "../plugin-runtime-host/messageEndpointManagers.js";
import { createMessageEndpointHostPorts } from "../runtime/messageEndpointHostPorts.js";
import { createAgentAdapterHostPorts } from "../runtime/agentAdapterHostPorts.js";
import { createRemoteCodexAndDeliver } from "./remoteCodexCreate.js";
import type { CallerCreationMetadataStatus } from "../callerCreationMetadata.js";
import { publishStartupPlanConflicts } from "./planStorageStartupPublication.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { ManagerEventHub, createManagerEventsOperation } from "./managerEvents.js";
import { PluginProfilePublication, createPluginReconciliationPublicationFence } from "./pluginProfilePublication.js";
import { pluginProfilePackageResolution } from "./pluginProfilePackageResolution.js";
import { preparedApiJson } from "./apiPreparedJson.js";
import { AgentRequestRouteReconciliation } from "./agentRequestRouteReconciliation.js";
import { parseAgentChatHistoryQuery, projectAgentChatHistory } from "../shared/agentChatHistory.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { ResourceCache, type ResourceCacheOptions } from "./resourceCache.js";
import { readRecordingAudio, readRecordingObject } from "./recordingObjectReader.js";
import { createResourceCacheOperations } from "../plugins/io.rabiroute.manager.core/src/manager/resourceCacheOperations.js";
import { MOBILE_RECORDING_MAX_CHUNKS } from "./resourceCacheProtocol.js";
import { authenticatedResourceOwner } from "./resourceApiRequest.js";
import { queryMessageHistory } from "./messageHistorySearchService.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { RecordingArchiveRuntime } from "./recordingArchiveRuntime.js";
import { RecordingArchiveAsrRuntime } from "./recordingArchiveAsrRuntime.js";
import type { RecordingArchiveAdminOptions } from "../plugins/io.rabiroute.manager.core/src/manager/recordingArchiveAdminOperation.js";
import { hasAuthenticatedConnectionRequest, markAuthenticatedConnectionRequest, markConsumedConnectionQueryParameters } from "./connectionRequestAccess.js";
import { createRabiLinkAgentDevices, type RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";
import { createRabiLinkAgentDeviceOperations } from "../plugins/io.rabiroute.manager.rabilink-relay/src/manager/rabiLinkAgentDeviceOperations.js";
import { createAgentStateReportOwner, createAgentStateReportOperations } from "../plugins/io.rabiroute.manager.agent-state-control/src/manager/agentStateReportOperations.js";
import { createGatewayListenerPublicationHost } from "./gatewayListenerPublication.js";
import { currentPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import { createPerformanceOperations } from "../plugins/io.rabiroute.manager.performance/src/manager/performanceOperations.js";
import { createBilibiliHistoryOperations } from "../plugins/io.rabiroute.manager.bilibili-history/src/manager/bilibiliHistoryOperations.js";
import type { DeviceAgentOwnerOptions } from "../plugins/io.rabiroute.agent.device-agent/src/agentAdapters/deviceAgentOwner.js";
import { deviceAgentDeliveryPrincipal } from "./deviceAgentDeliveryAccess.js";
import { createDeviceAgentPeerAuthority } from "./deviceAgentPeerAuthority.js";
import { createRabiLinkMobileOwner } from "../plugins/io.rabiroute.endpoint.rabilink/src/manager/rabiLinkMobileOwner.js";
import { createRabiLinkMobileOperations } from "../plugins/io.rabiroute.endpoint.rabilink/src/manager/rabiLinkMobileOperations.js";
import { RabiLinkDeviceConnections } from "./rabiLinkDeviceConnections.js";
import { rabiLinkAgentDevicePrincipal, rabiLinkAgentTaskSource, rabiLinkConnectionScope, rabiLinkTrustedTransport, rabiLinkTransportAssertionPresent } from "./rabiLinkAgentDeviceConnection.js";
import { recordingManifestHash } from "./recordingArchiveContract.js";
import { createAllDayRecording } from "./allDayRecordingRoutes.js";
import { createPersonaRecordingOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaRecordingOperations.js";
import { CompanionActivity, companionSpeechScope, readCompanionPresets, recordCompanionInteraction, saveCompanionSummary, lastCompanionSummary } from "./companionActivity.js";
import { readCompanionContext } from "./companionContextReader.js";
import { CompanionWindowTypes } from "./companionWindowTypes.js";
import { readCompanionSceneRules } from "./companionScene.js";
import type { PersonaCompanionContext } from "../plugins/io.rabiroute.manager.persona/src/manager/companionActivityRoutes.js";
import { createPersonaCompanionOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaCompanionOperations.js";
import { CompanionContinuationStore } from "./companionContinuation.js";
import { requestLocalSpeech, requestLocalSpeechJson } from "../speech/localSpeechClient.js";
import { normalizeRouteAgentTargets, resolvePrimaryAgentTarget, primaryAgentInstanceBindings, peerRouteAgentSession } from "../shared/routeAgentTargets.js";
import type { PeerTunnelRuntime } from "../peerTunnel/runtime.js";
import { createManagerPeerRuntime as prepareManagerPeerRuntime } from "./managerPeerRuntime.js";

import { errorResponsePresentation } from "../shared/errorPresentation.js";
import { KnowledgeSearchService } from "./knowledgeSearchService.js";
import { createPersonaKnowledgeOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaKnowledgeOperations.js";
import { createPersonaIdentityOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaIdentityOperations.js";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "../plugins/io.rabiroute.manager.persona/src/manager/personaStorageOperations.js";
import { createPersonaHealthOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaHealthOperations.js";
import { createPersonaHistoryOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaHistoryOperations.js";
import { createPersonaSkillOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaSkillOperations.js";
import type { RoleSkillArchiveReply } from "../plugins/io.rabiroute.manager.persona/src/manager/roleSkillDownloadRoutes.js";
import { authorizeLanAgentRoleSkillRequest } from "./lanAgentRoleSkillAccess.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import { manageInstanceAgent } from "../agentAdapters/instanceManagement.js";
import fs from "node:fs";
import { createVideoRuntime } from "../plugins/io.rabiroute.manager.video/src/manager/videoRuntime.js";
import { NativeWebguiStaticOwner } from "./nativeWebguiStaticOwner.js";
import { DataUpgradeService } from "./dataUpgradeService.js";
import { createDataUpgradeOperations } from "./dataUpgradeOperations.js";
import { createDataUpgradeHostRestart } from "./dataUpgradeHostRestart.js";
import { DATA_UPGRADE_STATUS_EVENT } from "../shared/dataUpgradeContract.js";
import { createWebguiStaticOperations } from "./webguiStaticOperations.js";
import { createVideoOperations } from "../plugins/io.rabiroute.manager.video/src/manager/videoOperations.js";
import { createRabiPeerRuntime } from "./rabiPeerRoutes.js";
import { discoverRabiPeers } from "../rabiPeerDiscovery.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { subscribeKnowledgeChanges } from "../roleKnowledgeSearch.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";


import {
  buildAgentDeliveryTestEnvelope,
  parseAgentDeliveryTestResult,
  type AgentDeliveryTestResult
} from "../agentDeliveryTest.js";
import { normalizeAgentAdapters, parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";
import { installAgentAdapterManifestReader, normalizePlanBindingAgentType, type AgentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import { agentThreadRequestFailureData, handleAgentThreadRequest as handleLocalAgentThreadRequest, readAgentEndpointSummary, type AgentThreadRequest, type AgentThreadRemoteSource, type AgentThreadRequestOptions } from "../agentThreads.js";
import { createAgentEndpointDelivery } from "./agentEndpointDelivery.js";
import { createCorePublicOperations } from "./corePublicOperations.js";
import { routeInstanceThread, type InstanceThreadTransport } from "./instanceThreadRouting.js";
import { instanceWorkerStateDirectory } from "../agentAdapters/instanceClient.js";
import { recordPersonaUserDelivery } from "./personaUserDeliveryHistory.js";
import { recordPersonaAgentDelivery } from "./personaAgentDeliveryHistory.js";
import { readChatDeliveryParties } from "./personaChatDeliveryLookup.js";
import { agentIdentityForMessageSource, type RabiAgentMessageSource, type RabiDeliveryEnvelope, type RabiMessageSource } from "../shared/rabiMessage.js";
import { AgentRequestStore, type AgentRequestParty } from "../agentRequests/store.js";
import { planBindingMatchesSource, planBindingTargetKey, type PlanBindingSource } from "../shared/planBindingOwner.js";
import { agentRequestStatePath } from "../agentRequests/persistence.js";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";
import { resolveRuntimeLayout } from "../shared/runtimeLayout.js";
import { isDshSessionId } from "../shared/dshSessionIdentity.js";
import { CompanionFrameDelivery } from "./companionFrameDelivery.js";
import { readCompanionObservationPolicy } from "./companionObservationInterval.js";
import { bindDshSessionForSave } from "../shared/codexSessionBinding.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { selectAgentThreadRouteId } from "./agentThreadRouteSelection.js";
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
import { listDeliveryReplayAttemptSnapshot } from "../deliveryReplayLedger.js";
import type { DeliveryReplayRequest } from "../deliveryReplay.js";


import { RemoteAgentHub, type RemoteAgentTask, type RemoteAgentTaskEvent, type RemoteAgentTaskRequest } from "../plugins/io.rabiroute.manager.remote-agent/src/messageEndpoints/remoteAgentManager.js";
import { appendMessageContextToDir } from "../messageContextStore.js";

import { managerRuntimeDiagnosticsSummary } from "../managerRuntimeDiagnostics.js";
import { createManagerOperationalLog, installOperationalMutationAuditSink, managerOperationalError } from "./operationalLog.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { PerformanceApi } from "../plugins/io.rabiroute.manager.performance/src/manager/performanceRoutes.js";
import { measureSyncPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import {
  createOperationContext,
  recordDataMutationAudit,
  runWithOperationContext
} from "../observability/dataMutationAudit.js";
import { readJsonlTail } from "./jsonlTail.js";


import { AgentCompletionDeliveryService, completionTaskContextFromPlans, deliverCompletionToEndpoint, planCompletionDeliveryRules } from "./agentCompletionDelivery.js";
import { inspectOriginalPlanFeedbackReceipt } from "./planFeedbackReceipt.js";
import { remoteAgentTargetKey } from "../shared/routeAgentTargets.js";
import { resolvePlanHistoryRequestActor } from "./planHistoryRequestActor.js";
import type { ReviewedReplySourceEvidence } from "../replyImageDescriptions.js";
import {
  handleAgentSend,
  inspectAgentSendDelivery,
  mapAgentSendReplyResult,
  prepareAgentSendRequest,
  validateAgentSendReplyImageDescriptions,
  type AgentSendRequest,
  type AgentSendResult
} from "../agentSend.js";
import type {
  AgentPlanFeedbackSubmitRequest,
  AgentPlanFeedbackSubmitResult
} from "../outbox.js";
import { agentReplyHistorySource, agentReplyCurrentQqBinding } from "../outbox.js";
import { installAgentAdapterGenerationReader } from "../runtime/agentAdapterProviders.js";
import { verifyQqFileCurrentPresence } from "./agentDeliveryVerification.js";
import { inspectOriginalAgentSendHistory } from "./agentSendHistoryVerification.js";
import { createAgentSendVerificationEvidenceVerifier } from "./agentSendVerificationEvidence.js";
import { verifyAgentSendDelivery, settleAgentSendDelivery } from "./agentSendReconciliation.js";
import { evaluateAgentSendLanguageStyle } from "../agentSendLanguageStyle.js";
import { AgentSendMessageLengthGuard } from "../agentSendMessageLength.js";
import { AgentSendConversationContextGuard } from "../agentSendConversationContext.js";
import { AgentSendConversationQueue } from "../agentSendConversationQueue.js";
import { agentSendRequestTemplateForSource } from "../agentSendTemplate.js";
import {
  MessageProcessingBoardStore,
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
import { MessageProcessingSendContextReview } from "../messageProcessing/sendContextReview.js";
import { resolveReviewedAgentSendGate, assertReviewedAgentSendMayDeliver } from "./reviewedAgentSendGate.js";
import { normalizeCodexMemoryConsolidationAgentModel } from "../shared/codexMemoryConsolidationAgent.js";
import {
  agentSendReceiptResponse,
  executeIdempotentAgentSend,
  findAgentSendTraces,
  readAgentSendReceipt
} from "./agentSendIdempotency.js";
import { normalizePipelineDefinition, type PipelineDefinition } from "../pipelines.js";
import {
  type RolePanelAttachment,
  type RolePanelTimelineAppendResult,
  type RolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import { readInstalledGatewayEndpointTypes } from "../plugin-runtime-host/messageEndpointOwnership.js";
import { DEFAULT_CODEX_HOOK_SETTINGS, gatewayMessageAdapterTypes as sharedGatewayMessageAdapterTypes, autoAssignGatewayPorts as sharedAutoAssignGatewayPorts, primaryMessageProcessingAgentAdapter, definitionUsesNapcat as sharedDefinitionUsesNapcat, normalizeNapCatInstances as sharedNormalizeNapCatInstances, gatewayAdapterTypes as sharedGatewayAdapterTypes, normalizeCodexHookSettings, agentHookSettingsFor, normalizeGatewayDefinition as sharedNormalizeGatewayDefinition, validateGatewayPortConflicts as sharedValidateGatewayPortConflicts, validateNapcatRouteCardinality, type CodexHookSettings, type CodexPlanAssistantSession, type CodexReasoningEffort, type MessageAdapterPolicies, type MessageProcessingAgentPolicies, type PersonaAutomationRuleDefinition, type RecentMessageLimits, type SpeechPushMode } from "../shared/gatewayConfigModel.js";
import {
  codexPlanAssistantInitializationPrompt,
  normalizeCodexPlanAssistantModel,
  planAssistantSessionAgentAdapter,
  resolveCodexPlanAssistantTurnModel
} from "../shared/codexPlanAssistantSessions.js";
import {
  resolvePersistedProjectPath,
  resolveProjectPath,
  toPersistedProjectPath
} from "../shared/projectPaths.js";
import { normalizePathForComparison } from "../shared/pathPolicy.js";
import { rabiRoutePackageVersion } from "../packageInfo.js";
import type { ManagerInstanceLock } from "../managerInstanceLock.js";
import {
  listenManagerEndpoint,
  parseManagerPortPolicy
} from "../managerEndpointPolicy.js";
import {
  handleManagerHostLifecycleRequest,
  managerHostIdentityFromEnvironment,
  managerReadyLine
} from "./hostLifecycle.js";
import {
  handleManagerLanDiscoveryRequest,
  MANAGER_DISCOVERY_PROTOCOL_VERSION
} from "./managerLanDiscovery.js";
import {
  startManagerDiscoveryPublisher,
  type ManagerDiscoveryStatus
} from "./managerLanDiscoveryPublisher.js";
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
import { ManagerConfigRepository, type ManagerConfig } from "./configRepository.js";
import {
  ManagerWatchBroker,
  disabledManagerWatchBrokerStatus,
  publicManagerWatchBrokerStatus,
  type ManagerWatchBrokerStatus,
  type ManagerWatchDiagnostic
} from "./managerWatchBroker.js";
import { resolveCodexRuntimeState } from "./codexRuntimeState.js";
import { createPluginServicePort } from "../runtime/pluginServicePort.js";
import type { SpeechPluginPorts } from "../plugins/io.rabiroute.manager.speech/src/manager/speechPluginRuntime.js";

import {
  CodexHookContextService,
  type AgentRequestStopResult,
  type CodexHookContextRequest,
  type PlanTaskCompletionDelivery,
} from "./codexHookContext.js";
import { observeManagerHttpAbort } from "./managerHttpAbort.js";
import { createStopStageObserver } from "./hookProgressDiagnostics.js";
import { memoryConsolidationHookScope } from "./memoryConsolidationHookScope.js";
import { createLanguageStyleOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/languageStyleRoutes.js";
import { createRolePanelOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/rolePanelOperations.js";
import { notifyRolePanelMessage } from "./rolePanelNotification.js";
import { runLocalAgentMessageProcess } from "./localAgentMessageProcess.js";
import { spawnGatewayCommandProcess } from "./gatewayCommandProcess.js";
import { createPluginCatalogOperations } from "./pluginCatalogOperations.js";
import type { PluginCatalogInvocation } from "./pluginCatalogRoutes.js";
import { PluginPackageStore } from "./pluginPackageStore.js";
import { createDesktopResourceResolver } from "./desktopQtResourceResolver.js";
import { createStartupPresentationProjector } from "./startupPresentation.js";
import { createSourcePatchHostService, ManagerSourcePatchService } from "./sourcePatchService.js";
import { SourcePatchWatcher } from "./sourcePatchWatcher.js";
import { AutomaticCodeService } from "./automaticCodeService.js";
import { withAutomaticCodeRequest } from "./automaticCodeRequest.js";
import { WebPatchWatcher } from "./webPatchWatcher.js";
import { handleSourcePatchApi } from "./sourcePatchRoutes.js";
import { WebPatchService } from "./webPatchService.js";
import { handleWebPatchApi } from "./webPatchRoutes.js";
import { HostInstanceIdentityReset } from "./identityResetRoutes.js";
import {
  GenerationRuntime,
  loadPluginProfile,
  PluginPackageCatalog,
  selectReadyPluginCandidates,
  type HostService,
  type LoadedPluginProfile,
  type PluginGeneration
} from "../plugin-kernel/index.js";
import { createFullPluginExecutor } from "../plugin-runtime-host/executor.js";
import { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import { pluginStorageMigrationFailure } from "../shared/pluginStorage.js";
import { createPluginManagement, readPluginManagementManifest } from "./pluginManagement.js";
import { createPluginManagementOperations } from "./pluginManagementOperations.js";
import { registerManagerBootstrap, splitManagerBootstrapPublicOperations } from "./managerBootstrap.js";
import { AsyncPluginOutcomeArchive } from "../plugin-runtime-host/asyncOutcomeArchive.js";
import type { RuntimeObservation } from "../plugin-runtime-host/bridge/executor.mjs";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
import { WebPluginModuleRegistry, retainedWebPackageCatalog } from "./webPluginModules.js";
import {
  ManagerPluginRouteRegistry,
  createManagerApiOperationsService,
  type ManagerPluginRouteHandler
} from "./managerPluginRouteRegistry.js";
import { isManagerControlRequestPath } from "./managerHttpRequestClassification.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import { DesktopPetOwner } from "../plugins/io.rabiroute.manager.desktop-pet/src/manager/desktopPetRoutes.js";
import { createDesktopPetOperations } from "../plugins/io.rabiroute.manager.desktop-pet/src/manager/desktopPetOperations.js";
import { createYeYuGamerManagerOperations } from "../plugins/io.rabiroute.manager.yeyu-gamer/src/integrations/yeyuGamer/managerRoutes.js";









import { createGatewayControlOperations } from "../plugins/io.rabiroute.manager.gateway-runtime/src/manager/gatewayControlOperations.js";
import { createRemoteAgentOperations, type RemoteAgentOperationsContext } from "../plugins/io.rabiroute.manager.remote-agent/src/manager/remoteAgentRoutes.js";
import { createAgentThreadControlOwner } from "../plugins/io.rabiroute.manager.agent-thread-control/src/manager/agentThreadControlRoutes.js";
import { createAgentThreadControlOperations } from "../plugins/io.rabiroute.manager.agent-thread-control/src/manager/agentThreadControlOperations.js";
import { createPeerAgentEndpointBridge } from "./peerAgentEndpointBridge.js";
import { createPeerAgentOperations } from "../plugins/io.rabiroute.manager.agent-thread-control/src/manager/peerAgentOperations.js";
import { createPeerRouteDeliveryOperations } from "../plugins/io.rabiroute.manager.agent-thread-control/src/manager/peerRouteDeliveryOperations.js";
import { createAgentCommunicationRoutes, type AgentCommunicationHttpResponse } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/agentCommunicationRoutes.js";
import { createApiDiscoveryOperations } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.js";
import { AgentUploadStore } from "./agentUploadStore.js";
import { createAgentUploadRoutes } from "../plugins/io.rabiroute.manager.agent-communication/src/manager/agentUploadRoutes.js";
import { guardRequestBodyDeadline } from "./agentUploadDeadline.js";
import { AgentAdapterCatalogService, mountAgentAdapterCatalogPlugin } from "../plugins/io.rabiroute.manager.agent-adapter-catalog/src/manager/agentAdapterCatalog.js";
import { AgentAdapterCatalogWorkerPool } from "./agentAdapterCatalogWorkerPool.js";
import type { AgentAdapterCatalogWorkerTask } from "./agentAdapterCatalogWorker.js";
import { invokeAgentManagerOperation, resolvePublishedAgentManagerProviders, resolvePublishedAgentManagerProvider, loadInstalledAgentManagerDescriptors,
  createPublishedAgentServiceEndpointBridge, createPublishedAgentDeviceEndpointBridge, type AgentManagerDescriptor } from "./agentManagerProviders.js";
import { mergeAgentSessionDescriptors, readAgentSessionBinding } from "../agentAdapters/agentPluginSessionBinding.js";
import type { AgentAdapterInvocation } from "@rabiroute/plugin-sdk";

import { MessageAdapterScanProviderRegistry } from "../shared/messageAdapterScanRegistry.js";
import type {
  MessageAdapterEndpoint,
  MessageAdapterScanResult as PluginMessageAdapterScanResult
} from "../plugins/io.rabiroute.manager.message-adapter-control/src/manager/messageAdapterControl.js";
import { type NapcatLaunchRequest } from "../plugins/io.rabiroute.endpoint.napcat/src/manager/napcatControlRoutes.js";
import { ManagerGatewayRuntimeService } from "./managerGatewayRuntimeService.js";
import { GenerationHandoffLease } from "./generationHandoffLease.js";


import { KnowledgeCallbackReminderService } from "../plugins/io.rabiroute.manager.message-processing-automation/src/manager/knowledgeCallbackReminderService.js";
import { PlanFeedbackRecoveryService } from "../plugins/io.rabiroute.manager.plan-feedback-delivery/src/manager/planFeedbackRecoveryService.js";
import { runWindowsTaskkill, stopChildProcessTree } from "../runtime/windowsProcessTree.js";
import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  MANAGER_SHARED_RESOURCES_RUNTIME_KEY,
  mountManagerSharedResourcesRuntime
} from "./managerSharedResourcesRuntime.js";
import { LanguageStyleValidator } from "../languageStyleValidation.js";
import { createPlanTaskCompletionDelivery } from "./planTaskCompletionDelivery.js";
import {
  deliverPlanApprovalFeedback,
  PlanFeedbackDeliveryPendingError,
  requireConfirmedPlanDelivery,
  type PlanApprovalFeedbackPersonaRequest,
  type PlanApprovalFeedbackSecretaryTarget,
  type PlanApprovalFeedbackTaskRequest
} from "./planApprovalFeedbackDelivery.js";
import {
  recoverPlanFeedbackCandidate as recoverPlanFeedbackCandidateBase,
  type PlanFeedbackDeliveryInspection,
  type PlanFeedbackRecoveryCandidate,
  type PlanFeedbackRecoveryOutcome,
  type PlanFeedbackRecoveryTaskRequest
} from "./planFeedbackRecovery.js";
import {
  reconcilePlanSecretaryBindingsForWorkspace,
  type PlanSecretaryTarget
} from "./planSecretaryAssignment.js";
import {
  ManualTriggerProcessRegistry,
  type ManualTriggerLaunchResult
} from "./manualTriggerProcess.js";
import {
  DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS,
  ManagerRuntimeOwner
} from "./managerRuntimeOwner.js";
import {
  MemoryConsolidationScheduler,
  type DueMemoryConsolidationRun,
  type MemoryConsolidationScheduleTarget
} from "../plugins/io.rabiroute.manager.memory-consolidation/src/manager/memoryConsolidationScheduler.js";
import { memoryConsolidationFailureDiagnostic } from "./memoryConsolidationDiagnostics.js";
import { evaluateMemoryConsolidationSchedule } from "./memoryConsolidationScheduleWorkerClient.js";
import { canonicalLogicalPlanId } from "../planStorageIdentity.js";
import {
  PlanStorageStartupLifecycle,
  type PlanStorageStartupLifecycleSnapshot
} from "./planStorageStartupLifecycle.js";
import {
  RouteCatalogOperationError,
  RouteCatalogStartupLifecycle,
  type RouteCatalogStartupLifecycleSnapshot
} from "./routeCatalogStartupLifecycle.js";
import { isRouteCatalogSnapshotInstalled, routeCatalogStartupUnavailable } from "./routeCatalogStartupHttpGate.js";
import type { RouteCatalogPersonaPresentation, RouteCatalogSnapshot } from "./routeCatalogTransaction.js";
import { publicPlanStorageStartupSnapshot } from "./planStorageStartupSnapshot.js";
import {
  consumePlanQaFeedback,
  type PlanQaStoragePort,
  type PlanQaTaskRequest
} from "./planQaFeedback.js";


import { RabiGlobalConfigStore, type RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { DeviceIdentityOwner } from "./deviceIdentity.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { ManagerLocalComputer } from "./managerLocalComputer.js";
import { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { createLanAgentManagementOperations, type LanAgentRoutesContext } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentRoutes.js";
import { createLanAgentConnectionOperation } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentConnectionOperation.js";
import { createLanAgentTerminalOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentTerminalRoutes.js";
import { createLanAgentComputerOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.js";
import type { InteractiveContext } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentInteractiveContract.js";
import { createLanAgentReadOperations, type LanAgentReadContext } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentReadOperations.js";
import { createWebguiAccessOperations } from "./webguiAccessOperations.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, isLanNodeMetadataRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { AgentResourceCatalog } from "../plugins/io.rabiroute.manager.core/src/manager/agentResourceCatalog.js";
import { validateLanAgentRequestBody, captureTrustedLanAgentSource, getTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { migrateLanAgentSharedCredential } from "./lanAgentCredentialMigration.js";
import {
  generateWebguiAccessToken,
  WEBGUI_TOKEN_QUERY_KEY,
  isLoopbackRemoteAddress,
  isLocalMachineRemoteAddress,
  isPublicWebguiStaticRequest,
  isWebguiLanRequestAuthorized,
  webguiTokenMatches,
  lanAddressPriority,
  managerListensOnLan
} from "./webguiLanAccess.js";
import { publicRabiLinkRelayConfig } from "../shared/rabiLinkRelayPublicConfig.js";
import { createRabiControlOperations } from "../plugins/io.rabiroute.manager.route-control/src/manager/rabiApiOperations.js";
import { parseGatewayReadyLine } from "../gatewayLifecycle.js";
import { createGatewayOutputLineReader, GATEWAY_MESSAGE_HISTORY_PREFIX } from "../gatewayMessageHistory.js";
import { gatewayMessageHistoryEvents, localMessageHistoryEvents } from "./gatewayMessageHistoryEvents.js";
import { subscribeMessageHistoryChanges } from "../messageHistoryChanges.js";
import { writeGatewayRouteBootSnapshot } from "../shared/gatewayRouteSnapshotBoot.js";
import { createGatewayRouteActivationOwner } from "./gatewayRouteActivationOwner.js";
import { mergeEndpointRouteDeclarations, readEndpointRouteDeclarations, readInstalledEndpointRouteDeclarations, type EndpointRouteConfigDeclaration } from "../plugin-runtime-host/messageEndpointRouteConfig.js";
import type { RouteCatalogApplicationContext } from "./routeCatalogStartupLifecycle.js";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";
import { RuntimeRegistry, type GatewayRuntime } from "./runtimeRegistry.js";
import {
  gatewayRuntimeStartDecision,
  gatewayRuntimeSyncAction,
  managerAutostartEnabled,
  managerConfigWatcherEnabled,
  managerReadOnlyEnabled,
  managerReadOnlyRequestAllowed
} from "./managerRuntimeMode.js";
import { buildManagerHealthSnapshot } from "./managerHealth.js";
import { resolveGatewayChildCommand } from "./gatewayChildCommand.js";
import {
  gatewayMessageAdapterEnvironment,
  routeMessageAdapterEnvironment,
  type MessageAdapterEnvironment
} from "./gatewayMessageAdapterEnvironment.js";
import { BilibiliHistoryBridge } from "../plugins/io.rabiroute.manager.bilibili-history/src/manager/bilibiliHistoryBridge.js";
import { createPersonaResourceOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaResourceOperations.js";
import { roleInfoPayload } from "./roleInfoPayload.js";
import type { ScanDiagnostic } from "./scanController.js";
import { PeerLanServer } from "./peerLanServer.js";
import { RabiDirectVideo } from "../plugins/io.rabiroute.manager.rabilink-relay/src/manager/rabiDirectVideo.js";
import { createDirectVideoOperations } from "../plugins/io.rabiroute.manager.rabilink-relay/src/manager/rabiDirectVideoRoutes.js";
import {
  ManagerReadWorkerError,
  managerCatalogWorkerPool,
  managerKnowledgePageWorkerPool,
  managerPerformanceWorkerPool,
  managerReadWorkerPool
} from "./managerReadWorkerPool.js";

import { RoleStorageApplication, RoleStorageApplicationError, roleStorageOperationKey, type RoleStorageCommandContext, type RoleStoragePlanFeedbackProjection } from "./roleStorageApplication.js";
import { createPlanUpdateExecutorRestorer } from "./planUpdateExecutorPackages.js";
import type { PlanUpdateExecutorService } from "./planUpdateExecutor.js";
import {
  ensurePlanSecretaryBindingForEvent,
  replacePlanSecretaryBindingForEvent,
  replacePlanTaskBindingForDelivery
} from "./planBindingStorageMutation.js";
import {
  captureGatewayDiagnosticsWorkerInput,
  GatewayDiagnosticsSnapshotService,
  memoryOnlyGatewayRuntimeStatus,
  type GatewayDiagnosticsWorkerInput,
  type GatewayDiagnosticsWorkerResult
} from "./gatewayDiagnosticsSnapshot.js";
import { DeveloperCandidateAdmission } from "./developerCandidateAdmission.js";
import { readGatewayDiagnosticsStatuses } from "./gatewayDiagnosticsRead.js";
import { buildIsolatedGatewayDiagnosticsSnapshot } from "./gatewayDiagnosticsSnapshotWorker.js";
import { GatewayStatusSnapshotService, readGatewayStatusInWorker } from "./gatewayStatusSnapshot.js";
import { createPersonaDirectoryOperation, createPersonaMessagingOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/personaMessagingRoutes.js";
import { loadPersonaMessageAuthority, type PersonaMessageAuthority } from "./personaMessageAuthority.js";
import { handleRoleContextProjectionRequest } from "./roleContextProjection.js";
import { resolveInProcessRoots } from "../plugin-kernel/pluginExecutionSettings.js";

import { hostOwnedSpeechMessageCommand } from "./speechMessageIngress.js";
import type { ManagerSpeechDeliveryOutcome } from "../plugins/io.rabiroute.manager.speech/src/manager/speechControl.js";
import { SpeechControlError } from "../shared/speechErrors.js";

import {
  DesktopSettingsStore,
  desktopSettingsPath
} from "./desktopSettings.js";



import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import { stickySpeechAuthority } from "../shared/speechRequestAuthority.js";
import {
  parseSpeechProcessResult,
  SPEECH_EXIT_DELIVERED,
  SPEECH_EXIT_RECORDED,
  SPEECH_PROCESS_RESULT_MARKER
} from "../speechMessageDelivery.js";
import type {
  SpeechIngressRecord,
} from "../shared/speechControlContract.js";
import { standaloneGatewayPayload as buildStandaloneGatewayPayload } from "./statusPayload.js";
import { createRoleConfigurationOperations } from "../plugins/io.rabiroute.manager.persona/src/manager/roleConfigurationRoutes.js";
import { RoleLifecycleError, assertRoleAcceptsWork, checkedRoleDirectory, withRoleLock } from "../roleLifecycle.js";
import { handleRemotePersonaResolutionApi, resolveRemotePersonaSnapshot, validateRemotePersonaLanguageStyle, type RemotePersonaReadContext } from "./remotePersonaRoutes.js";
import { assertLocalPersonaOwner, localPersonaMessageDirectories, localPersonaRoleForAgentTask, localPersonaRuntimeForDelivery, routeOwnsLocalPersona } from "./localPersonaOwner.js";
import { getPlan, getPublishedPlan, listPlans, publishedRolePlans, roleKnowledgeSnapshotFromPublishedCatalog, subscribePlanUpdates, type PlanItem } from "../roleKnowledge.js";

import { resolvePlanAttachmentFile } from "../planAttachments.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";

import { verifyCriticalProjectFactRecordInWorker as verifyCriticalProjectFactRecord } from "./criticalFactRead.js";
import { planFeedbackResponseId, type PlanFeedbackDeliveryStatus, type PlanFeedbackPostCommit, type PlanFeedbackRecord } from "../planFeedback.js";
import { type PlanFeedbackAttachmentUpload } from "../shared/planFeedbackContract.js";


import {
  type WearableHealthAlertDeliveryContext
} from "../wearableHealthAlertDelivery.js";
import type { WearableHealthAlert } from "../wearableHealth.js";

type ManagerPluginHandlerRouteSpec =
  | {
      routeId: string;
      kind: "exact";
      path: string;
      methods?: readonly string[];
      handlerIndex?: number;
    }
  | {
      routeId: string;
      kind: "prefix";
      pathPrefix: string;
      methods?: readonly string[];
      handlerIndex?: number;
    };

function registerManagerPluginHandlerRoutes(
  registry: ManagerPluginRouteRegistry,
  instanceId: string,
  routeIdPrefix: string,
  handlers: readonly ManagerPluginRouteHandler[],
  routes: readonly ManagerPluginHandlerRouteSpec[]
): () => void {
  return registry.register(instanceId, routes.map(route => {
    const handler = handlers[route.handlerIndex ?? 0];
    if (!handler) {
      throw new Error(`Manager plugin route ${routeIdPrefix}.${route.routeId} references a missing handler.`);
    }
    return {
      routeId: `${routeIdPrefix}.${route.routeId}`,
      match: route.kind === "exact"
        ? { kind: "exact" as const, path: route.path, methods: route.methods }
        : { kind: "prefix" as const, pathPrefix: route.pathPrefix, methods: route.methods },
      handler
    };
  }));
}

type GatewayDefinition = {
  agentRecipients?: import("../shared/agentDeliveryTarget.js").AgentRecipientDefinition[];
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
  dshAgentPreset?: string;
  dshModelProvider?: string;
  workbuddySessionId?: string;
  workbuddySessionName?: string;
  workbuddyCwd?: string;
  workbuddyEndpoint?: string;
  antigravityConversationId?: string;
  antigravityConversationName?: string;
  antigravityCwd?: string;
  dshModel?: string;
  dshReasoningEffort?: string;
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
  agentInstanceBindings?: Record<string, AgentInstanceBinding>;
  remoteAgentTargets?: import("../shared/routeAgentTargets.js").RemoteAgentTarget[];
  primaryAgentTarget?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  grokBotProfilePath?: string;
  grokBotBackendUrl?: string;
  grokBotAgentId?: string;
  grokBotSessionId?: string;
  grokBotSessionName?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleDeviceId?: string;
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
  agentRoleDeviceId?: string;
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
  targetUserId?: string;
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
  timeOfDays?: string[];
  onceAt?: string;
};

type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

type AgentMessageSource = RabiAgentMessageSource;

function agentMessageSourceForSession(
  sessionIdInput: unknown,
  sessionNameInput?: unknown,
  agentAdapter: AgentAdapterType = "codex",
  agentType?: string,
  workspace?: string
): AgentMessageSource {
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) throw new Error("Agent message source requires a source session id.");
  const sessionName = String(sessionNameInput || "").trim();
  if (!sessionName) throw new Error("Agent message source requires a source session name.");
  return {
    type: "agent",
    agentAdapter: isDshSessionId(sessionId) ? "dsh" : agentAdapter,
    agentType,
    sessionId,
    sessionName,
    workspace: String(workspace || "").trim() || undefined
  };
}

/**
 * Read the primary Agent's session identity from the definition.
 *
 * Installed package metadata owns field mappings, even while a plugin is disabled.
 * Missing mappings never borrow a different platform's saved task.
 */
function currentAgentSessionDescriptors(): ReadonlyMap<string, AgentManagerDescriptor> {
  return mergeAgentSessionDescriptors(installedAgentDescriptors.values(),
    resolvePublishedAgentManagerProviders(publishedPluginGeneration()).map(provider => ({
      type: provider.type, capability: provider.capability, manifest: provider.manifest,
      sessionBinding: provider.sessionBinding ?? {}
    })));
}

function configuredLocalAgentSessionFields(
  definition: GatewayDefinition,
  agentAdapter: AgentAdapterType
): { sessionId?: string; sessionName?: string; workspace?: string } {
  return readAgentSessionBinding(currentAgentSessionDescriptors().get(agentAdapter), definition);
}

function configuredAgentProviderTypes(definition: GatewayDefinition): AgentAdapterType[] {
  const providers = new Set(normalizeAgentAdapters(definition.agentAdapters));
  for (const descriptor of currentAgentSessionDescriptors().values()) {
    const type = parseAgentAdapterType(descriptor.type);
    if (type && readAgentSessionBinding(descriptor, definition).sessionId) providers.add(type);
  }
  return [...providers];
}

function primaryAgentSessionFields(definition: GatewayDefinition, agentAdapter: AgentAdapterType) {
  return peerRouteAgentSession(definition, agentAdapter) ?? configuredLocalAgentSessionFields(definition, agentAdapter);
}

function primaryAgentMessageSource(definition: GatewayDefinition): AgentMessageSource {
  const agentAdapter = definition.primaryAgentAdapter
    || normalizeAgentAdapters(definition.agentAdapters)[0]
    || "codex";
  const fields = primaryAgentSessionFields(definition, agentAdapter);
  return agentMessageSourceForSession(
    fields.sessionId,
    fields.sessionName,
    agentAdapter,
    "主角色 Agent",
    fields.workspace
  );
}

function planMessageSource(
  planIdInput: unknown,
  planNameInput: unknown,
  sourceAgent?: AgentMessageSource
): RabiMessageSource {
  const planId = canonicalLogicalPlanId(planIdInput);
  const planName = String(planNameInput || "").trim();
  if (!planName) throw new Error("Plan message source requires planName.");
  const { type: _type, ...agentIdentity } = sourceAgent || {} as AgentMessageSource;
  return {
    type: "plan",
    planId,
    planName,
    ...(sourceAgent ? { sourceAgent: agentIdentity } : {})
  };
}

function primaryAgentWorkspace(definition: GatewayDefinition): string | undefined {
  definition = effectiveInstanceDefinition(definition);
  const adapter = resolvePrimaryAgentTarget(definition)?.provider ?? "codex";
  return adapter ? primaryAgentSessionFields(definition, adapter).workspace : undefined;
}

function primaryAgentSessionId(definition: GatewayDefinition): string | undefined {
  definition = effectiveInstanceDefinition(definition);
  const adapter = resolvePrimaryAgentTarget(definition)?.provider ?? "codex";
  return adapter ? primaryAgentSessionFields(definition, adapter).sessionId : undefined;
}

function runtimeOwnsAgentSession(runtime: GatewayRuntime, sessionId: string, request?: AgentThreadRequest): boolean {
  const id = sessionId.trim();
  if (!id) return false;
  const remote = id === request?.threadId ? request.instanceBinding : undefined;
  if (!remote && String(runtime.definition.codexThreadId || "").trim() === id) return true;
  if (!remote && String(runtime.definition.dshSessionId || "").trim() === id) return true;
  if (!remote && String(runtime.definition.grokBotSessionId || "").trim() === id) return true;
  if (!remote && (runtime.definition.codexPlanAssistantSessions ?? []).some((session) => session.threadId === id)) return true;
  const target = currentMessageProcessingTargetByThreadId(id);
  if (!remote && target && runtimeForMessageProcessingTarget(target)?.definition.id === runtime.definition.id) return true;
  if (!routeOwnsLocalPersona(runtime.definition)) return false;
  const roleId = roleIdForDefinition(runtime.definition);
  if (!roleId) return false;
  const roleDir = roleDirForApi(roleId);
  const plans = publishedRolePlans(roleDir);
  if (!plans) {
    requestRoleKnowledgeCatalogRefresh(roleDir);
    return false;
  }
  return plans.some(plan => remote
    ? planBindingTargetKey(plan.taskBinding ?? {}) === planBindingTargetKey({ agentType: request?.agentAdapter, sessionId: id, instanceBinding: remote })
    : (plan.taskBinding?.sessionId === id && !plan.taskBinding.instanceBinding) || plan.secretaryBinding?.sessionId === id);
}

let instanceThreadTransport: InstanceThreadTransport | undefined;
let agentEndpointDelivery: ReturnType<typeof createAgentEndpointDelivery> | undefined;
function effectiveInstanceDefinition(definition: GatewayDefinition): GatewayDefinition {
  // Route destinations already contain the explicit provider/session; never replace them from a computer catalog.
  return definition;
}

function messageWorkerDataDir(definition: GatewayDefinition): string {
  const target = resolvePrimaryAgentTarget(definition);
  const adapter = target?.provider;
  const binding = target?.binding;
  return binding ? instanceWorkerStateDirectory(dataDirFor(definition), binding, primaryAgentSessionId(definition) || "unavailable") : dataDirFor(definition);
}
async function handleAgentThreadRequest(request: AgentThreadRequest, options: AgentThreadRequestOptions,
  trustedDeviceSource?: NonNullable<ReturnType<typeof rabiLinkAgentDevicePrincipal>>) {
  const deviceProvider = resolvePublishedAgentManagerProviders(publishedPluginGeneration()).find(provider => provider.type === "deviceAgent");
  const deviceEndpoint = deviceProvider?.deviceEndpoint as { handlesThreadRequest?(request: AgentThreadRequest): boolean } | undefined;
  const handlesDeviceMetadata = deviceEndpoint?.handlesThreadRequest
    ? deviceEndpoint.handlesThreadRequest(request)
    : Boolean(deviceProvider && request.agentAdapter === deviceProvider.type && request.action !== "send" && request.action !== "reconcile_delivery");
  if (deviceProvider && handlesDeviceMetadata) {
    const result = await deviceProvider.invoke<Awaited<ReturnType<typeof import("../plugins/io.rabiroute.agent.device-agent/src/manager/deviceAgentThreads.js").handleDeviceAgentThreadRequest>>>(
      "threads.request", { request }, { nativeArgs: [request, options], assertCurrent: options.requestAuthority });
    if (result) return result;
  }
  if (request.action === "create" && request.prompt != null && request.prompt !== "" && request.agentAdapter === "codex" && request.instanceBinding && !("ownerDeviceId" in request.instanceBinding && request.instanceBinding.ownerDeviceId) && instanceThreadTransport && !instanceThreadTransport.instances().some(item => item.local && item.instanceId === request.instanceBinding!.instanceId)) {
    if (!agentEndpointDelivery) throw new Error("Manager endpoint delivery authority is unavailable.");
    const endpoint = agentEndpointDelivery.options(options.remoteSource, options.requestAuthority, trustedDeviceSource, undefined, options.callerExecutionOptions);
    const transport = instanceThreadTransport;
    const manageCreation = async (binding: NonNullable<AgentThreadRequest["instanceBinding"]>, params: Record<string, unknown>): Promise<CallerCreationMetadataStatus> => {
      options.requestAuthority?.();
      const instance = transport.instances().find(item => item.instanceId === binding.instanceId);
      if (!instance?.connected || instance.enabled === false || instance.local) throw new Error("The original target computer is unavailable for metadata creation.");
      const result = await transport.manage(binding.instanceId, { ...params, agentId: binding.agentId, agentAdapter: "codex" }, options.requestAuthority) as { statusCode?: number; data?: { creation?: CallerCreationMetadataStatus; message?: string } };
      options.requestAuthority?.();
      if (!result || !result.statusCode || result.statusCode < 200 || result.statusCode >= 300 || !result.data?.creation) throw new Error(result?.data?.message || "Original target SDK metadata creation receipt is unavailable.");
      return result.data.creation;
    };
    return createRemoteCodexAndDeliver({ rootDir, request, endpoint,
      metadataStatus: (binding, key) => manageCreation(binding, { action: "creation_status", creationIntent: { callerKey: key } }),
      createMetadata: metadata => { const { instanceBinding, ...body } = metadata; return manageCreation(instanceBinding!, { ...body, action: "create_metadata" }); },
      sendPrepared: body => handleLocalAgentThreadRequest(body, { ...options, endpointDelivery: endpoint, ...(options.remoteSource ? { remoteEndpoint: agentEndpointDelivery!.remoteEndpoint } : {}) })
    });
  }
  if (request.action === "send" || request.action === "reconcile_delivery") {
    if (!agentEndpointDelivery) throw new Error("Manager endpoint delivery authority is unavailable.");
    return handleLocalAgentThreadRequest(request, { ...options,
      endpointDelivery: agentEndpointDelivery.options(options.remoteSource, options.requestAuthority, trustedDeviceSource, undefined, options.callerExecutionOptions),
      // Return coordinates reuse ingress attribution without another source-owner lookup.
      ...(options.remoteSource ? { remoteEndpoint: agentEndpointDelivery.remoteEndpoint } : {}) });
  }
  options.requestAuthority?.();
  const remote = instanceThreadTransport ? await routeInstanceThread(request, instanceThreadTransport) : undefined;
  options.requestAuthority?.();
  if (!remote) return handleLocalAgentThreadRequest(request, options);
  return remote;
}

function runtimeForAgentThreadRequest(request: AgentThreadRequest): GatewayRuntime | undefined {
  const sourceAgent = request.messageSource
    ? agentIdentityForMessageSource(request.messageSource)
    : undefined;
  const runtimeList = [...runtimes.values()];
  const requestSessionIds = [request.threadId, sourceAgent?.sessionId, request.sourceThreadId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const routeId = selectAgentThreadRouteId({
    targetSessionId: request.threadId,
    messageSourceSessionId: sourceAgent?.sessionId,
    sourceThreadId: request.sourceThreadId,
    needsDsh: request.agentAdapter === "dsh"
      || sourceAgent?.agentAdapter === "dsh"
      || requestSessionIds.some((id) => isDshSessionId(id)),
    workspace: request.cwd
  }, runtimeList.map((runtime) => ({
    id: runtime.definition.id,
    ownedSessionIds: requestSessionIds.filter((id) => runtimeOwnsAgentSession(runtime, id, request)),
    supportsDsh: normalizeAgentAdapters(runtime.definition.agentAdapters).includes("dsh"),
    dshWorkspaces: [
      runtime.definition.dshCwd,
      ...(runtime.definition.codexPlanAssistantSessions ?? [])
        .filter((session) => planAssistantSessionAgentAdapter(session) === "dsh")
        .map((session) => session.workspace)
    ].map((value) => String(value || "").trim()).filter(Boolean)
  })));
  return routeId ? runtimes.get(routeId) : undefined;
}

function agentThreadRequestOptions(
  request: AgentThreadRequest,
  extra: Partial<AgentThreadRequestOptions> = {}
): AgentThreadRequestOptions {
  const runtime = runtimeForAgentThreadRequest(request);
  const targetRuntime = request.threadId && request.agentAdapter !== "dsh"
    ? runtimeForAgentThreadRequest({ threadId: request.threadId, agentAdapter: "codex" })
    : undefined;
  const explicitDshBaseUrl = String(request.dshBaseUrl || "").trim();
  return {
    invokeAgentOperation: invokePublishedAgentOperation,
    getProviders: () => resolvePublishedAgentManagerProviders(publishedPluginGeneration()),
    assertNewAgentTask: () => assertComputerFeaturePolicyEnabled(configRepository.readComputerFeaturePolicy("agentTasks")),
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    // Defaults belong to the target Route, never to an unrelated sending persona.
    ...(targetRuntime ? {
      codexDefaults: {
        model: targetRuntime.definition.agentModel,
        reasoningEffort: targetRuntime.definition.agentReasoningEffort
      }
    } : {}),
    onChatHistoryDelivery: (body, result) => recordPersonaAgentDelivery(body, result, {
      readDeliveryParties: ids => readChatDeliveryParties(agentRequests, ids),
      roleForTask: (sessionId, workspace) => {
        const configuredDefinitions = configuredPersonaDefinitionsForSession(sessionId);
        if (configuredDefinitions.some(definition => !routeOwnsLocalPersona(definition))) return undefined;
        const binding = codexHookContextService.getBinding(sessionId);
        if (binding?.cwd && workspace && !hookWorkspaceMatches(binding.cwd, workspace)) return undefined;
        const definitions = [...gatewayIdsForManagedSession(sessionId, workspace)]
          .map(id => runtimes.get(id)?.definition)
          .filter((definition): definition is GatewayDefinition => Boolean(definition));
        return localPersonaRoleForAgentTask(definitions, roleIdForDefinition, binding?.roleId);
      },
      roleDir: roleDirForApi,
      changed: roleId => publishManagerEvent("persona_chat_history_changed", { roleId })
    }),
    ...(explicitDshBaseUrl
      ? { dshBaseUrl: explicitDshBaseUrl }
      : runtime?.definition.dshBaseUrl
        ? { dshBaseUrl: runtime.definition.dshBaseUrl }
        : {}),
    ...extra,
    dshAgentPreset: request.dshAgentPreset?.trim() || extra.dshAgentPreset,
    readGrokBotSource: (sessionId) => invokePublishedAgentOperation<{ sessionId: string; sessionName: string } | null>(
      "grokBot", "readGrokBotSource", { sessionId })
  };
}

type AgentRuntimeState = Record<string, unknown> & {
  agentAdapterType: AgentAdapterType;
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

const managerRuntimeLayout = resolveRuntimeLayout(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
);
const packageRoot = managerRuntimeLayout.packageRoot;
const rootDir = managerRuntimeLayout.stateRoot;
const resourceCacheKey = randomUUID();
const allDayRecording = createAllDayRecording({
  roleDirectory: roleDirForApi,
  hostId: os.hostname(),
  mobileRoot: path.join(rootDir, "data", "mobile-recording-events"),
  mobileAudio: async (owner, chunks, authorize) => {
    return readRecordingAudio(owner, chunks, recordingChunk, authorize);
  },
  speechUrl: () => speechServiceUrl(),
  ensureSpeech: async () => { await speechRuntimeControl.start(); },
  changed: roleId => publishManagerEvent("all_day_recording", { roleId }),
  indexChanged: (roleId, indexDay, indexFailed) => publishManagerEvent("all_day_recording", { roleId, indexDay, indexFailed }),
  readChanged: (roleId, event) => publishManagerEvent("all_day_recording", { roleId, ...event })
});
const companionFrameDelivery = new CompanionFrameDelivery(rootDir);
const companionObservationPolicy = readCompanionObservationPolicy(JSON.parse(fs.readFileSync(path.join(packageRoot, "packages", "rabi-companion", "observation.json"), "utf8")));
const companionActivity = new CompanionActivity({
  observationPolicy: companionObservationPolicy,
  transcripts: async (roleId, startedAt, endedAt, assertCurrent) => {
    assertCurrent?.();
    const result = await allDayRecording.reads.transcripts(roleId, startedAt, endedAt);
    assertCurrent?.(); return result;
  },
  transcribe: async (reviewId, wav, signal, interval, assertCurrent) => {
    assertCurrent?.();
    const form = new FormData();
    form.set("job_key", `companion_${reviewId.replaceAll("-", "")}`);
    form.set("response_format", "verbose_json");
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "system-playback.wav");
    const serviceUrl = speechServiceUrl();
    const response = await currentSpeechService().runAcceptedWork(() => {
      assertCurrent?.();
      return requestLocalSpeech(serviceUrl, "/v1/archive/transcriptions", { method: "POST", body: form }, {
      timeoutMs: companionObservationPolicy.transcriptionTimeoutSeconds * 1000,
      fetchImpl: ((input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, init!.signal!]) })) as typeof fetch
    });
    });
    assertCurrent?.();
    if (response.status !== 200) throw new Error(`System playback ASR HTTP ${response.status}`);
    const body = JSON.parse(response.body.toString("utf8"));
    if (typeof body.text !== "string") throw new Error("System playback ASR returned no text");
    if (signal.aborted) throw new Error("Companion observation changed");
    assertCurrent?.();
    await allDayRecording.service.savePlayback(interval.roleId, reviewId, interval.startedAt, interval.endedAt, body.text, wav, assertCurrent);
    assertCurrent?.();
    return body.text;
  },
  windowTypes: new CompanionWindowTypes(roleDirForApi),
  presets: readCompanionPresets(JSON.parse(fs.readFileSync(path.join(packageRoot, "packages", "rabi-companion", "presets.json"), "utf8"))),
  sceneRules: readCompanionSceneRules(JSON.parse(fs.readFileSync(path.join(packageRoot, "packages", "rabi-companion", "scene-rules.json"), "utf8"))),
  changed: (roleId, session) => {
    publishManagerEvent("companion_changed", { roleId, session });
    void companionFrameDelivery.retain(session?.status === "active" ? session.review?.id : undefined).catch(() => undefined);
  },
  reaction: event => publishManagerEvent("companion_reaction", event),
  context: async (session, assertCurrent) => {
    assertCurrent?.();
    const runtime = runtimes.get(session.gatewayId);
    if (!runtime || roleIdForDefinition(runtime.definition) !== session.roleId) throw new Error("Activity Route no longer belongs to this persona");
    assertLocalPersonaOwner(runtime.definition, "Companion context");
    const roleDirectory = roleDirForApi(session.roleId);
    return readCompanionContext({ roleDirectory, personaFile: runtime.definition.agentRoleFile, session }, {
      assertCurrent,
      onIssues: issues => managerOperationalLog.record("warn", "companion_memory_items_skipped", {
        action: session.roleId,
        result: `skipped=${issues.length}`,
        error: managerOperationalError(new Error(issues.slice(0, 10).map(item => `${item.file}: ${item.message}`).join("\n")), rootDir)
      })
    });
  },
  deliver: async (session, review, assertCurrent) => {
    assertCurrent?.();
    const runtime = runtimes.get(session.gatewayId);
    if (!runtime || roleIdForDefinition(runtime.definition) !== session.roleId) throw new Error("Activity Route no longer belongs to this persona");
    assertLocalPersonaOwner(runtime.definition, "Companion activity");
    let recoveredOwnerUrl: string | undefined;
    if (runtime.definition.primaryAgentAdapter === "dsh") {
      recoveredOwnerUrl = await invokePublishedAgentOperation<string>("dsh", "ensureCompanionOwner", {
        configPath: adapterConfigPath(runtime.definition.configName || runtime.definition.id)
      }, { assertCurrent });
      assertCurrent?.();
      appendLog(runtime, `companion Agent owner ready: ${review.id}`);
    }
    const current = companionActivity.snapshot(session.roleId).session;
    if (!current || current.id !== session.id || current.revision !== review.revision || current.review?.id !== review.id || current.status !== "active") {
      throw new Error("陪伴场景已改变，已取消旧画面投递");
    }
    const imagePath = review.frame ? await companionFrameDelivery.stage(review.id, review.frame, review.expiresAt) : undefined;
    assertCurrent?.();
    const afterStage = companionActivity.snapshot(session.roleId).session;
    if (afterStage?.review?.id !== review.id || afterStage.revision !== review.revision || afterStage.status !== "active") {
      await companionFrameDelivery.retain(afterStage?.status === "active" ? afterStage.review?.id : undefined);
      assertCurrent?.();
      throw new Error("陪伴场景已改变，已取消旧画面投递");
    }
    assertCurrent?.();
    await triggerGatewayRolePanelMessage(runtime, `companion-${review.id}`, review.text,
      imagePath ? [{ kind: "image", name: "activity-sequence.jpg", path: imagePath,
        url: `${managerBaseUrl}/api/roles/${encodeURIComponent(session.roleId)}/companion/frame?reviewId=${review.id}` }] : [],
      { companion: { sessionId: session.id, revision: review.revision, reviewId: review.id }, suppressTaskAnnouncement: true },
      recoveredOwnerUrl ? { RABI_DSH_LOCAL_OWNER_URL: recoveredOwnerUrl } : undefined, assertCurrent);
    assertCurrent?.();
  },
  speak: async (session, text, expiresAt, assertCurrent) => {
    assertCurrent?.();
    const serviceUrl = speechServiceUrl();
    const response = await currentSpeechService().runAcceptedWork(() => {
      assertCurrent?.();
      return requestLocalSpeech(serviceUrl, "/v1/audio/speech", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text, voice: session.roleId, play: true,
        session_id: companionSpeechScope(session), playback_deadline: expiresAt / 1000 })
    }, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.speak.requestLocalSpeech.timeoutMs", 120_000) });
    });
    assertCurrent?.();
    if (response.status !== 200) throw new Error(`RabiSpeech HTTP ${response.status}`);
  },
  cancelSpeech: async (scope, assertCurrent) => {
    assertCurrent?.();
    const result = await requestLocalSpeechJson(speechServiceUrl(), "/v1/playback/cancel-session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: scope })
    }, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.cancelSpeech.requestLocalSpeechJson.timeoutMs", 5000) });
    assertCurrent?.();
    if (result.status !== 200) throw new Error(`RabiSpeech HTTP ${result.status}`);
  },
  record: async (session, assertCurrent) => {
    assertCurrent?.();
    if (session.observationOwner === "desktop") {
      const recording = await allDayRecording.service.snapshot(session.roleId, assertCurrent);
      assertCurrent?.(); if (!recording.enabled) return;
    }
    assertCurrent?.();
    await recordCompanionInteraction(roleDirForApi(session.roleId), session, assertCurrent);
    assertCurrent?.();
  },
  save: async (session, assertCurrent) => {
    assertCurrent?.();
    if (session.observationOwner === "desktop") {
      const recording = await allDayRecording.service.snapshot(session.roleId, assertCurrent);
      assertCurrent?.(); if (!recording.enabled) return;
    }
    assertCurrent?.();
    await saveCompanionSummary(roleDirForApi(session.roleId), session, assertCurrent);
    assertCurrent?.();
    await allDayRecording.store.append(session.roleId, { id: `companion:${session.id}`, deviceId: os.hostname(),
      startedAt: session.startedAt, endedAt: session.endedAt || session.startedAt, source: "session", kind: "status", state: "saved",
      text: `${session.title || session.presetId} · ${session.positionSeconds === null ? "" : `${Math.floor(session.positionSeconds)}s`} · ${session.notes.length} 条讨论` }, undefined, assertCurrent);
    assertCurrent?.();
    publishManagerEvent("all_day_recording", { roleId: session.roleId });
  }
});
const companionActivityContext: PersonaCompanionContext = {
  get service() { return companionActivity; },
  roleDirectory: roleDirForApi,
  identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
  continuation: new CompanionContinuationStore(),
  local: request => isLocalMachineRemoteAddress(request.socket.remoteAddress, []), readOnly: () => managerReadOnly,
  verifyGateway: (roleId, gatewayId) => {
    const candidates = [...runtimes.values()].filter(item => roleIdForDefinition(item.definition) === roleId && !item.definition.agentRoleDeviceId && item.definition.enabled);
    const runtime = gatewayId ? runtimes.get(gatewayId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!runtime || !runtime.definition.enabled || roleIdForDefinition(runtime.definition) !== roleId) throw new Error("Select an enabled Route for this persona");
    assertLocalPersonaOwner(runtime.definition, "Companion activity");
    return runtime.definition.id;
  },
  saveSummaryDefault: async roleId => (await allDayRecording.service.snapshot(roleId)).enabled === true,
  last: roleId => lastCompanionSummary(roleDirForApi(roleId))
};
const resourceCache = new ResourceCache(path.join(rootDir, "data"));
/** Bound owners publish objects to the archive namespace; unbound owners keep the legacy cache. */
const recordingChunk = (owner: string, id: string, authorize?: () => void) => readRecordingObject(
  owner, id,
  (objectOwner, objectId) => resourceCache.read(objectOwner, objectId),
  (objectOwner, objectId) => recordingArchiveRuntime.store.readObject(objectOwner, objectId),
  authorize
);
const resourceCacheOptions: ResourceCacheOptions = {
  local: request => isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address)),
  tunnelKey: () => resourceCacheKey,
  readOnly: () => managerReadOnly,
  receiveRecording: async (owner, body, authorize = () => {}) => {
    authorize();
    const chunks = (body as { chunks?: unknown })?.chunks;
    if (!Array.isArray(chunks) || chunks.length > MOBILE_RECORDING_MAX_CHUNKS) throw new Error("Invalid recording chunks");
    // A missing segment degrades playback only; the timeline event still lands.
    await allDayRecording.store.receiveMobile(owner, body, authorize);
    authorize();
    publishManagerEvent("all_day_recording", { mobile: true });
  }
};
let recordingArchiveAsrRuntime: RecordingArchiveAsrRuntime | undefined;
const recordingArchiveRuntime = new RecordingArchiveRuntime({
  stateDir: path.join(rootDir, "data"),
  roleDirectory: roleId => roleDirForApi(roleId),
  workerId: () => rabiLinkRelayConfigForMeta().deviceId,
  authorizeResources: request => authenticatedResourceOwner(request, {
    local: candidate => isLocalMachineRemoteAddress(candidate.socket.remoteAddress, []), key: () => resourceCacheKey
  }),
  localAdmin: request => isLocalMachineRemoteAddress(request.socket.remoteAddress, [])
    && request.headers["x-rabilink-tunnel-local"] === undefined,
  readOnly: () => managerReadOnly,
  onCommitted: async (owner, manifest, receipt) => {
    if (!managerReadOnly) await recordingArchiveAsrRuntime?.onCommitted(owner, manifest, receipt);
  },
  readProcessing: async (owner, recordId, manifestHash) => {
    if (!recordingArchiveAsrRuntime) return null;
    const record = await recordingArchiveRuntime.store.getRecord(owner, recordId);
    if (record.receipt.manifestHash !== manifestHash || recordingManifestHash(record.manifest) !== manifestHash) {
      throw new Error("archive_processing_manifest_mismatch");
    }
    const result = await recordingArchiveAsrRuntime.readResult({ owner, ...record, processingVersion: "initial" });
    const state = result.state;
    if (state !== "not_requested" && state !== "queued" && state !== "running" && state !== "completed"
      && state !== "failed" && state !== "blocked" && state !== "ambiguous") throw new Error("archive_processing_state_invalid");
    return { state, jobKey: result.jobKey, processingVersion: "initial",
      ...(result.state === "completed" && result.result ? { text: result.result.text } : {}) };
  }
});
const recordingArchiveAdminOptions: RecordingArchiveAdminOptions = {
  bindings: recordingArchiveRuntime.bindings,
  receiptRoot: path.join(rootDir, "data"),
  identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
  workerId: () => rabiLinkRelayConfigForMeta().deviceId,
  readOnly: () => managerReadOnly,
  changed: async () => {
    await recordingArchiveRuntime.restore();
    if (!managerReadOnly) await recordingArchiveAsrRuntime?.restore();
  }
};
const managerHostIdentity = managerHostIdentityFromEnvironment();
const instanceIdentityReset = new HostInstanceIdentityReset({ stateRoot: rootDir,
  applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? "" });
const managerPortPolicy = parseManagerPortPolicy(process.env.GATEWAY_MANAGER_PORT);
let managerPort = managerPortPolicy.mode === "fixed" ? managerPortPolicy.port : 0;
let managerBaseUrl = managerPort > 0 ? `http://127.0.0.1:${managerPort}` : "";
let managerInstanceId = "";
let managerSourcePatchStatus: (() => ReturnType<ManagerSourcePatchService["status"]>) | undefined;
const managerPluginProbeDiagnostics = new Map<string, Readonly<{ instanceId: string; pid: number | null; requestId: string; deadlineMs: number; observedAt: number }>>();
function capturePluginRuntimeObservation(observation: RuntimeObservation): void {
  const key = observation.identity.activationId;
  if (observation.probe && observation.state === "committed" && !observation.observation.close) {
    managerPluginProbeDiagnostics.set(key, Object.freeze({ instanceId: observation.identity.instanceId, pid: observation.pid, ...observation.probe }));
  } else managerPluginProbeDiagnostics.delete(key);
}
function pluginReadinessWithProbeObservations(readiness: Readonly<{ state: "ready" | "degraded"; missingCapabilities: readonly string[] }>): Readonly<{ state: "ready" | "degraded"; missingCapabilities: readonly string[] }> {
  return managerPluginProbeDiagnostics.size ? Object.freeze({ ...readiness, state: "degraded" as const }) : readiness;
}
let managerPluginGenerationStatus: Readonly<{
  id: string;
  sequence: number;
  readiness: Readonly<{ state: "ready" | "degraded"; missingCapabilities: readonly string[] }>;
}> | undefined;
let managerLanDiscoveryStatus: ManagerDiscoveryStatus = Object.freeze({
  state: "disabled",
  serviceType: "_rabiroute._tcp.local"
});
type ActiveStorageLifecycleGeneration = Readonly<{
  roleStorage: RoleStorageApplication;
  planStorage: PlanStorageStartupLifecycle;
  routeCatalog: RouteCatalogStartupLifecycle;
  requestHandler: http.RequestListener;
}>;

let activeStorageLifecycleGeneration: ActiveStorageLifecycleGeneration | undefined;

function planStorageStartupStatus(): PlanStorageStartupLifecycleSnapshot {
  return activeStorageLifecycleGeneration?.planStorage.snapshot() ?? Object.freeze({
    state: "idle",
    attempt: 0,
    incidents: 0,
    lastTransitionAt: new Date().toISOString()
  });
}

function routeCatalogStartupStatus(): RouteCatalogStartupLifecycleSnapshot {
  return activeStorageLifecycleGeneration?.routeCatalog.snapshot() ?? Object.freeze({
    state: "idle",
    attempt: 0,
    incidents: 0,
    lastTransitionAt: new Date().toISOString()
  });
}
const managerHttpLimits = {
  get requestTimeoutMs() { return getTimeoutMs("http.request", 30000); },
  get headersTimeoutMs() { return getTimeoutMs("http.headers", 10000); },
  get keepAliveTimeoutMs() { return getTimeoutMs("http.keepAlive", 5000); },
  maxRequestsPerSocket: 0
} as const;
const managerOperationalLog = createManagerOperationalLog({ rootDir });
const gatewayDiagnosticsReadLog = managerOperationalLog.bind("gateway_diagnostics", "warn");
const uninstallDataMutationAuditSink = installOperationalMutationAuditSink(managerOperationalLog, rootDir);
const messageProcessingBoardPersistence = new CoalescingMessageProcessingBoardPersistence(
  messageProcessingBoardStatePath(rootDir),
  {
    onCommitted: (state, durationMs) => {
      const revision = state && typeof state === "object" && !Array.isArray(state)
        ? String((state as { updatedAt?: unknown }).updatedAt ?? "").trim() || undefined
        : undefined;
      recordDataMutationAudit({
        group: "message.processing",
        event: "message_processing_snapshot_committed",
        owner: "CoalescingMessageProcessingBoardPersistence",
        action: "persist_snapshot",
        target: { type: "message_processing_board", id: "board" },
        dataSource: { kind: "file", id: "data/.runtime/message-processing-board.json" },
        outcome: "committed",
        after: revision ? { revision } : undefined,
        durationMs
      });
    },
    onError: error => {
      recordDataMutationAudit({
        level: "error",
        group: "message.processing",
        event: "message_processing_snapshot_commit_failed",
        owner: "CoalescingMessageProcessingBoardPersistence",
        action: "persist_snapshot",
        target: { type: "message_processing_board", id: "board" },
        dataSource: { kind: "file", id: "data/.runtime/message-processing-board.json" },
        outcome: "failed",
        error
      });
    }
  }
);
const messageProcessingBoard = new MessageProcessingBoardStore(messageProcessingBoardPersistence);
const agentRequests = new AgentRequestStore(agentRequestStatePath(rootDir));
const agentRequestRouteReconciliation = new AgentRequestRouteReconciliation({
  ready: () => agentRequests.ready(),
  reconcile: () => reconcileMessageProcessingAgentRequests(),
  onError: error => managerOperationalLog.record("error", "message_agent_request_bindings_reconciliation_failed", {
    error: managerOperationalError(error, rootDir)
  })
});
let knowledgeCallbackReminderService: KnowledgeCallbackReminderService<MessageProcessingRequirement> | undefined;
const managerRequestContexts = new WeakMap<http.ServerResponse, {
  requestId: string;
  method: string;
  pathname: () => string;
  startedAt: number;
  responseBytes?: number;
  peerAddress?: string;
  peerPort?: number;
  assertResponseAuthority?: () => void;
}>();
const managerReadOnly = managerReadOnlyEnabled();
const deviceIdentityOwner = new DeviceIdentityOwner(rootDir);
deviceIdentityOwner.assertStartup();
const rabiGlobalConfig = new RabiGlobalConfigStore(rootDir);
deviceIdentityOwner.ensureBound(managerReadOnly);
rabiGlobalConfig.reload();
const managerHostOverride = process.env.GATEWAY_MANAGER_HOST?.trim() || "";
const managerHost = managerHostOverride || (!managerReadOnly && rabiGlobalConfig.read().webguiLan.enabled ? "0.0.0.0" : "127.0.0.1");
const managerShouldAutostart = !managerReadOnly && managerAutostartEnabled();
const remoteAgentPublicHost = process.env.REMOTE_AGENT_PUBLIC_HOST || process.env.GATEWAY_MANAGER_PUBLIC_HOST || "";
const configRepository = new ManagerConfigRepository({ rootDir, managerPort, resolveComputerDefinition: () => resolvePublishedPluginService("manager.computer-settings-definition@1") as ComputerSettingsDefinition | undefined });
const messageEndpointManagers = new MessageEndpointManagers();

const managerEventHub = new ManagerEventHub({
  subscribe: publish => {
    const stopKnowledge = subscribeKnowledgeChanges((roleDir, change) => {
      if (change.kind === "plan") publish("plan_changed", { roleId: path.basename(roleDir), planId: change.item.id });
    });
    const stopMessages = subscribeMessageHistoryChanges(directory => {
      for (const runtime of runtimes.values()) {
        for (const event of localMessageHistoryEvents({
          directory, definition: runtime.definition, rootDir, routeDataDir: dataDirFor(runtime.definition),
          roleIdForDefinition, roleDirectory: roleDirForApi
        })) publish("message_endpoint_history_changed", event);
      }
    });
    return () => { stopKnowledge(); stopMessages(); };
  }
});

export function closeManagerEventClients(): void { managerEventHub.closeAll(); }
function publishManagerEvent(eventType: string, data: unknown): void { managerEventHub.publish(eventType, data); }
export function createManagerEventOperationDefinition(): ApiOperationDefinition { return createManagerEventsOperation(managerEventHub); }

export type ManagerSignalTarget = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function installManagerSignalHandlers(
  shutdown: (reason: "SIGINT" | "SIGTERM") => void,
  target: ManagerSignalTarget = process
): () => void {
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  target.on("SIGINT", onSigint);
  target.on("SIGTERM", onSigterm);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    target.removeListener("SIGINT", onSigint);
    target.removeListener("SIGTERM", onSigterm);
  };
}

export function listenManagerServer(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

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

function runtimeForAgentSendRoute(routeId: string): GatewayRuntime | undefined {
  const exact = runtimes.get(routeId);
  if (exact) return exact;
  return [...runtimes.values()].find((runtime) =>
    (runtime.definition.routeProfiles ?? []).some((profile) => profile.id === routeId)
  );
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
  },
  onEvent: (eventType, data) => {
    if (eventType === "outbox_receipt") recordRabiLinkRelayReceipt(data);
  }
});

function readManagerConfig(): ManagerConfig {
  return configRepository.readManagerConfig();
}

function writeManagerConfig(cfg: ManagerConfig): void {
  configRepository.writeManagerConfig(cfg);
}

function managerRolesRoot(): string { return configRepository.requireDomainRoot("roles"); }
function managerRouteRoot(): string { return configRepository.requireDomainRoot("route"); }
let routeCatalogConfig: GatewayConfigFile = { gateways: [] };
let routeCatalogPersonaPresentations: readonly RouteCatalogPersonaPresentation[] = Object.freeze([]);
let roleKnowledgeCatalogsReady = false;
let knowledgeSearchService: KnowledgeSearchService | undefined;
let personaMessageAuthority: PersonaMessageAuthority | undefined;
const messageProcessingSendContextReview = new MessageProcessingSendContextReview({
  getRequirement: (requirementId) => messageProcessingBoard.getRequirement(requirementId),
  findRequirementBySourceMessage: (routeId, messageId) => messageProcessingBoard.findLatestBySourceMessage(routeId, messageId),
  findRequirementsBySourceMessage: (routeId, messageId) => messageProcessingBoard.findBySourceMessage(routeId, messageId),
  loadContext: async (requirement, sourceMessageId, reviewedSource) => {
    const roleId = String(requirement.source.roleId || "").trim();
    if (!roleId) return [];
    const routeId = String(requirement.source.routeProfileId || requirement.source.routeId || "").trim();
    const runtime = runtimeForAgentSendRoute(routeId);
    if (!runtime) throw new Error("Message source Route is no longer available.");
    const profile = runtime.definition.routeProfiles?.find(item => item.id === routeId);
    const remoteDeviceId = profile?.agentRoleDeviceId ?? runtime.definition.agentRoleDeviceId;
    const auditDir = profile?.dataDir ?? runtime.definition.dataDir;
    const sourceDir = remoteDeviceId
      ? (auditDir ? path.resolve(rootDir, auditDir) : dataDirFor(runtime.definition))
      : roleDirForApi(roleId);
    return managerKnowledgePageWorkerPool.run({
      type: "message_processing_send_context",
      input: {
        roleDir: sourceDir,
        requirement: { id: requirement.id, source: requirement.source, ...(reviewedSource ? { sourceEvidenceReview: requirement.sourceEvidenceReview } : {}) },
        sourceMessageId,
        reviewedSource
      }
    });
  }
});

function currentPersonaMessageAuthority(): PersonaMessageAuthority {
  personaMessageAuthority ??= loadPersonaMessageAuthority(rootDir);
  return personaMessageAuthority;
}

function remotePersonaReadContext(): RemotePersonaReadContext {
  return {
    identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
    managerBaseUrl,
    remoteGeneration: async deviceId => {
      if (!activePeerTunnel) throw new Error("Peer tunnel is not ready.");
      await activePeerTunnel.ensureApplicationConnection(deviceId);
      return (await activePeerTunnel.session(deviceId)).remote.generation;
    },
    fetchRemote: async (deviceId, pathname, init) => {
      if (!activePeerTunnel) throw new Error("Peer tunnel is not ready.");
      return activePeerTunnel.fetch(deviceId, "persona", pathname, init);
    }
  };
}
const agentCompletionDelivery = new AgentCompletionDeliveryService({
  rules: (request, roleIds) => {
    const roles = new Set<string>();
    return [...runtimes.values()].flatMap(runtime => {
      const roleId = sanitizeRoleId(runtime.definition.agentRoleId);
      if (!roleId || roles.has(roleId) || runtime.definition.enabled === false || runtime.definition.agentRoleDeviceId) return [];
      if (roleIds && !roleIds.includes(roleId)) return [];
      roles.add(roleId);
      return [
        ...(agentHookSettingsFor(runtime.definition.codexHooks, request.agentType).completionDeliveries ?? []).map(rule => ({ roleId, rule })),
        ...planCompletionDeliveryRules(roleId, listPlans(roleDirForApi(roleId)), request.sessionId, request)
      ];
    });
  },
  taskContext: async ({ roleId, rule }, request) => {
    const plans = listPlans(roleDirForApi(roleId));
    let taskName: string | undefined;
    try { if (!request.sourceInstance) taskName = (await invokePublishedAgentOperation<{ title?: string } | undefined>("codex", "readCodexDesktopThread", { sessionId: request.sessionId }))?.title?.trim(); }
    catch (error) {
      managerOperationalLog.record("warn", "completion_task_title_unavailable", {
        action: request.sessionId, error: managerOperationalError(error, rootDir)
      });
    }
    const context = completionTaskContextFromPlans(request.sessionId, plans, taskName, request);
    if (!request.sourceInstance && rule.destination.channel === "napcat" && request.agentType === "codex" && request.turnId) {
      const imageError = (error: unknown) => {
        context.imageReadError = true;
        managerOperationalLog.record("warn", "completion_images_unavailable", {
          action: request.sessionId, error: managerOperationalError(error, rootDir)
        });
      };
      try {
        context.images = await invokePublishedAgentOperation<Awaited<ReturnType<typeof import("../plugins/io.rabiroute.agent.codex/src/manager/completionImages.js").readCodexTurnImages>>>(
          "codex", "readCompletionImages", { sessionId: request.sessionId, turnId: request.turnId }, { onError: imageError });
      } catch (error) { imageError(error); }
    }
    return context;
  },
  deliver: async ({ rule }, hook, deliveryId, context) => {
    const runtime = runtimes.get(rule.destination.gatewayId);
    if (!runtime || runtime.definition.enabled === false) throw new Error("目标消息路线未启用。");
    const instances = runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition);
    const instance = instances.find(item => item.id === rule.destination.params.instanceId && item.enabled !== false);
    if (rule.destination.channel === "napcat" && !instance) throw new Error("目标 QQ 账号未启用或已被移除。");
    const options = {
      endpointEgress: (capability: string) => resolvePublishedPluginService(capability) as import("@rabiroute/plugin-sdk").MessageEndpointEgressProvider | undefined,
      publishHtmlAttachment: (file: string, id: string) => {
        const shares = resolvePublishedPluginService("manager.html-shares@1") as { publish(file: string, id: string): Promise<string> } | undefined;
        if (!shares) throw new Error("HTML share plugin is unavailable; enable its dependencies or disable HTML-to-link conversion to send the original file.");
        return shares.publish(file, id);
      },
      rootDir, routeRoot: managerRouteRoot(), rolesRoot: managerRolesRoot(), publishEvent: publishManagerEvent, speechServiceUrl: speechServiceUrl(),
      runtimes: [{ ...runtime.definition, napcatInstances: instances.map(item => ({ ...item, accessToken: item.accessToken ?? "" })) }]
    };
    await deliverCompletionToEndpoint(rule, hook, deliveryId,
      runtime.definition.routeProfiles?.[0]?.id || runtime.definition.id, options, context);
  }
});
const codexHookContextService = new CodexHookContextService({
  onHookStage: createStopStageObserver(managerOperationalLog),
  readContext: async input => {
    const options = { timeoutMs: getTimeoutMs("agent.codex.hookRead", Number(process.env.RABIROUTE_CODEX_HOOK_READ_TIMEOUT_MS) || 45_000) };
    const current = input.kind === "knowledge" ? {
      ...input, memories: await managerKnowledgePageWorkerPool.queryRoleMemoryCatalogs(input.trigger.roleDir, options)
    } : input;
    return managerKnowledgePageWorkerPool.run({ type: "codex_hook_context_read", input: current }, options);
  },
  deliverAgentCompletion: async (request, roleIds) => {
    const results = await agentCompletionDelivery.handle(request, roleIds);
    for (const result of results) {
      managerOperationalLog.record(result.status === "failed" ? "warn" : "info", "agent_completion_delivery", {
        action: result.ruleId, outcome: result.status, result: result.reason
      });
    }
    return results;
  },
  rolesRoot: () => managerRolesRoot(),
  storePath: path.join(rootDir, "data", "codex-hook", "sessions.json"),
  deliverPlanTaskCompletion,
  hookEnabled: codexHookEnabled,
  memoryConsolidationInputIds: (request, roleId, runId) => memoryConsolidationHookScope(
    request, roleId, runId,
    routeCatalogConfig.gateways.map((definition) => ({
      roleId: roleIdForDefinition(definition),
      roleDir: roleDirForDefinition(definition),
      dataDir: dataDirFor(definition)
    }))
  ),
  recordAgentRequestStop,
  chatHistoryRoleIds: request => [...gatewayIdsForManagedSession(request.sessionId, request.cwd, request)]
    .map(id => runtimes.get(id)?.definition)
    .filter((definition): definition is GatewayDefinition => Boolean(definition && routeOwnsLocalPersona(definition)))
    .map(definition => sanitizeRoleId(definition.agentRoleId))
    .filter((roleId): roleId is string => Boolean(roleId)),
  onChatHistoryChanged: roleId => publishManagerEvent("persona_chat_history_changed", { roleId }),
});
const languageStyleValidator = new LanguageStyleValidator();
const messageLengthGuard = new AgentSendMessageLengthGuard();
const conversationContextGuard = new AgentSendConversationContextGuard((dataDir, filter, query) =>
  managerReadWorkerPool.run({ type: "conversation_window", dataDir, filter, query }));
const conversationSendQueue = new AgentSendConversationQueue();
const webuiDistPath = path.join(packageRoot, "ribiwebgui", "dist");
const runtimes = new RuntimeRegistry();
const persistedPerformanceConfig = rabiGlobalConfig.read().performance;
const performanceMonitoring = new PerformanceMonitoringService(rootDir, managerReadOnly
  ? { ...persistedPerformanceConfig, enabled: false }
  : persistedPerformanceConfig);
let memoryConsolidationScheduler: MemoryConsolidationScheduler | undefined;
const planTaskCompletionDelivery = createPlanTaskCompletionDelivery<GatewayRuntime>({
  getRuntime: gatewayId => runtimes.get(gatewayId),
  listRuntimes: () => [...runtimes.values()],
  roleIdForDefinition,
  triggerRolePanelMessage: triggerGatewayRolePanelMessage,
  appendTimeline: appendRolePanelTimeline,
  assignSecretary: async (runtime, delivery) => (await ensurePlanSecretaryTarget(
    runtime,
    delivery.roleId,
    delivery.plan,
    `completion:${delivery.sourceSessionId}:${delivery.sourceTurnId}`
  )).target,
  sendToSecretary: sendPlanTaskCompletionToSecretary,
  publishEvent: publishManagerEvent
});
type PublishedSpeechService = ReturnType<typeof import("../plugins/io.rabiroute.manager.speech/src/manager/speechPluginRuntime.js").createSpeechPluginRuntime>;
let resolvePublishedPluginService: (capability: string) => unknown = () => undefined;
async function requestWeixinLogin(dataDir: string): Promise<void> {
  const provider = resolvePublishedPluginService("endpoint.weixin.egress@1") as import("@rabiroute/plugin-sdk").MessageEndpointEgressProvider | undefined;
  if (!provider) throw new Error("Weixin endpoint plugin is unavailable.");
  const lease = provider.acquire({ dataDir });
  try { await lease.call("requestWeixinLogin", [dataDir]); }
  finally { lease.release(); }
}
let publishedPluginGeneration: () => PluginGeneration | undefined = () => undefined;
let installedAgentDescriptors: ReadonlyMap<string, AgentManagerDescriptor> = new Map();
function invokePublishedAgentOperation<T = unknown>(type: string, operation: string, payload: unknown, invocation?: AgentAdapterInvocation): Promise<T> {
  return invokeAgentManagerOperation<T>(publishedPluginGeneration(), type, operation, payload, invocation);
}

function currentSpeechService(): PublishedSpeechService {
  const service = resolvePublishedPluginService("manager.speech@1") as PublishedSpeechService | undefined;
  if (!service) throw new SpeechControlError("Speech service plugin is disabled or unavailable.", 503);
  return service;
}
const speechIngressStore = createPluginServicePort(() => currentSpeechService().speechIngressStore);
function peerRelayConfig() {
  const config = rabiGlobalConfig.read();
  const relay = rabiLinkRelayConfigForMeta();
  return {
    url: relay.url,
    token: relay.token,
    deviceId: relay.deviceId,
    deviceGuid: config.rabiGuid
  };
}
let activePeerRuntime: ReturnType<typeof createRabiPeerRuntime> | undefined;
let activePeerTunnel: PeerTunnelRuntime | undefined;
function admitPeerProxyUpgrade(request: http.IncomingMessage, url: URL, lanAgentAuthority: LanAgentAuthority): boolean {
  const generation = managerHostIdentity?.applicationGenerationId ?? managerInstanceId;
  const scope = rabiLinkConnectionScope(rabiLinkRelayConfigForMeta());
  if (rabiLinkTransportAssertionPresent(request) && !rabiLinkTrustedTransport(request, generation, scope)) {
    return false;
  }
  const access = evaluateLanAgentRequest(request, lanAgentAuthority, rabiGlobalConfig.read().webguiLan.enabled,
    () => rabiGlobalConfig.getLanAgentAdmissionPolicy());
  if (access.kind === "denied") { return false; }
  if (access.kind === "agent") assertTrustedLanAgentPrincipal(request);
  else if (!webguiLanRequestAllowed(request, url)) { return false; }
  const admittedRabiLink = rabiLinkTrustedTransport(request, generation, scope);
  markAuthenticatedConnectionRequest(request, () => {
    if (access.kind === "agent") assertTrustedLanAgentPrincipal(request);
    if (admittedRabiLink && (scope !== rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())
      || !rabiLinkTrustedTransport(request, managerHostIdentity?.applicationGenerationId ?? managerInstanceId, scope))) {
      throw new Error("Authenticated connection scope or generation was revoked.");
    }
    if (access.kind !== "agent" && !webguiLanRequestAllowed(request, url)) {
      throw new Error("Authenticated Manager connection was revoked.");
    }
  });
  return true;
}
const peerLanServer = new PeerLanServer({
  peerHandler: (request, url, response) => activePeerRuntime?.handler(request, url, response) ?? false,
  peerUpgrade: (request, socket, head) => {
    const shares = resolvePublishedPluginService("manager.html-shares@1") as { upgrade(request: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): boolean } | undefined;
    return shares?.upgrade(request, socket, head) || (activePeerTunnel?.upgrade(request, socket, head) ?? false);
  },
  port: Number(process.env.RABILINK_PEER_LAN_PORT ?? 0),
  onStatus: status => {
    publishManagerEvent("peer_lan_status", status);
    if (status.state === "listening") activePeerTunnel?.startLanDiscovery(status.port || 0);
  }
});
const selectionSpeechSettings = createPluginServicePort(() => currentSpeechService().selectionSpeechSettings);
const desktopSettings = new DesktopSettingsStore(desktopSettingsPath(rootDir));
const speechComputeTarget = new AsyncLocalStorage<string>();
const managerSpeechControlPorts: SpeechPluginPorts["control"] = {
  contextKey: () => speechComputeTarget.getStore() ?? (activePeerTunnel?.selected() || ""),
  serviceUrl: () => speechServiceUrl(),
  personas: routeCatalogPersonas,
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
};
const speechControl = createPluginServicePort(() => currentSpeechService().speechControl);
const speechRuntimeControl = createPluginServicePort(() => currentSpeechService().speechRuntimeControl);
const agentStateByGateway = new Map<string, Partial<Record<AgentAdapterType, AgentRuntimeState>>>();
const remoteAgentToken = process.env.REMOTE_AGENT_TOKEN?.trim() || "";
let remoteAgentHub: RemoteAgentHub | undefined;
let agentAdapterCatalogService: AgentAdapterCatalogService | undefined;
let agentManagerScanWorkers: AgentAdapterCatalogWorkerPool | undefined;
let watchedConfigSnapshot = "";
// Route catalog mutations already apply their committed snapshot to the live
// Manager. The config watcher observes that same durable write later; consuming
// that one echo prevents a second lifecycle recapture and Gateway restart.
let pendingManagedConfigWatchEchoes = 0;
let configWatchLifecycle: ManagerWatchBrokerStatus = disabledManagerWatchBrokerStatus();
let pluginPackageWatchLifecycle: ManagerWatchBrokerStatus = disabledManagerWatchBrokerStatus();

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
    || isLocalMachineRemoteAddress(request.socket.remoteAddress, request.socket.localAddress ? [request.socket.localAddress] : [])
  ) return true;
  if (isPublicWebguiStaticRequest(request.method, requestUrl.pathname)) return true;
  if (isWebguiLanRequestAuthorized(request, requestUrl, rabiGlobalConfig.read().webguiLan)) return true;
  if (isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address))) return true;
  if (remoteRequestUsesIndependentAuthorization(request, requestUrl)) return true;
  if (requestUrl.pathname.startsWith("/api/lan-agent/") && request.headers.authorization) {
    const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] ?? "" : request.headers.authorization ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    const lan = rabiGlobalConfig.read().webguiLan;
    return lan.enabled && webguiTokenMatches(token, lan.accessToken);
  }
  return isWebguiLanRequestAuthorized(request, requestUrl, rabiGlobalConfig.read().webguiLan);
}

function definitionFingerprint(definition: GatewayDefinition): string {
  return JSON.stringify(definition);
}

function routeCatalogMutationFailure(
  error: unknown
): Error & { statusCode: number; code: string } {
  const conflict = error instanceof RouteCatalogOperationError
    && error.code === "ROUTE_CATALOG_REVISION_CONFLICT";
  return Object.assign(new Error(conflict
    ? "Route catalog changed; refresh and retry this update."
    : "Route catalog update is temporarily unavailable."), {
    statusCode: conflict ? 409 : 503,
    code: conflict ? "route_catalog_conflict" : "route_catalog_unavailable",
    cause: error
  });
}

function routeCatalogVersion(): Readonly<{
  contentHash: string;
  routeConfigHash: string;
  presentationHash: string;
  revision: number;
}> {
  const snapshot = routeCatalogStartupStatus();
  return Object.freeze({
    // Compatibility: public contentHash remains the route mutation CAS token.
    contentHash: snapshot.routeConfigHash ?? "",
    routeConfigHash: snapshot.routeConfigHash ?? "",
    presentationHash: snapshot.presentationHash ?? "",
    revision: snapshot.revision ?? 0
  });
}

function routeCatalogPersonas(): RouteCatalogSnapshot["personas"] {
  return routeCatalogPersonaPresentations;
}

function requireRouteCatalogLifecycle(): RouteCatalogStartupLifecycle {
  if (!activeStorageLifecycleGeneration) {
    throw routeCatalogMutationFailure(new Error("Route catalog lifecycle is unavailable."));
  }
  return activeStorageLifecycleGeneration.routeCatalog;
}

async function ensureDataDirs(): Promise<void> {
  try {
    await requireRouteCatalogLifecycle().recapture();
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

function readConfig(): GatewayConfigFile {
  return structuredClone(routeCatalogConfig);
}

async function removeGatewayConfig(
  id: string,
  expectedContentHash: string | undefined,
  operationId: string
): Promise<void> {
  const decodedId = decodeURIComponent(id);
  const runtime = runtimes.get(decodedId);
  const configName = runtime
    ? sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName
    : routeRuntimeParts(decodedId).configName || sanitizeConfigName(decodedId);
  if (!configName) {
    throw new Error(`Invalid gateway id: ${decodedId}`);
  }
  try {
    await requireRouteCatalogLifecycle().remove(configName, expectedContentHash, operationId);
    pendingManagedConfigWatchEchoes += 1;
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

async function writeConfig(
  config: GatewayConfigFile,
  expectedContentHash: string | undefined,
  operationId: string
): Promise<GatewayConfigFile> {
  if (!Array.isArray(config.gateways)) {
    throw new Error("routes must be an array");
  }

  messageEndpointManagers.validateRoutes(config.gateways, readConfig().gateways);
  const normalized = { gateways: config.gateways.map(normalizeDefinition) };

  sharedAutoAssignGatewayPorts(normalized.gateways, managerPort);
  sharedValidateGatewayPortConflicts(normalized.gateways);
  try {
    await withRoleBindings(normalized.gateways, () => requireRouteCatalogLifecycle().replace(normalized, expectedContentHash, operationId));
    pendingManagedConfigWatchEchoes += 1;
    return readConfig();
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

async function withRoleBindings<T>(definitions: readonly GatewayDefinition[], action: () => Promise<T>): Promise<T> {
  const previous = readConfig().gateways;
  const bindings = [...new Set(definitions.filter(item => item.agentRoleId && !item.agentRoleDeviceId).map(item => item.agentRoleId!))].sort();
  async function lockAt(index: number): Promise<T> {
    if (index === bindings.length) return action();
    const roleId = bindings[index];
    const directory = roleFolderPath(managerRolesRoot(), roleId);
    return withRoleLock(directory, async () => {
      const createsReference = definitions.some(item => item.agentRoleId === roleId && !item.agentRoleDeviceId
        && !previous.some(old => old.id === item.id && old.agentRoleId === roleId && !old.agentRoleDeviceId));
      if (createsReference) { await checkedRoleDirectory(managerRolesRoot(), roleId); await assertRoleAcceptsWork(directory); }
      return lockAt(index + 1);
    });
  }
  return lockAt(0);
}

async function writeGatewayConfig(id: string, definition: GatewayDefinition, hash: string, operationId: string): Promise<void> {
  messageEndpointManagers.validateRoutes([...readConfig().gateways.filter(item => item.id !== definition.id), definition], readConfig().gateways);
  const normalized = normalizeDefinition(definition);
  if (normalized.dshAgentPreset) {
    await bindDshSessionForSave(normalized, request => handleLocalAgentThreadRequest(request, agentThreadRequestOptions(request)));
  }
  // The worker merges only this Route with its authoritative catalog inside the CAS transaction.
  try {
    await withRoleBindings([normalized], () => requireRouteCatalogLifecycle().upsert(normalized, hash, operationId, id));
    pendingManagedConfigWatchEchoes += 1;
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

async function resolveRouteMutation(operationId: string): Promise<{ state: "committed" | "not_committed" }> {
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(operationId)) {
    throw Object.assign(new Error("Invalid Route operation id."), { statusCode: 400 });
  }
  const lifecycle = requireRouteCatalogLifecycle();
  // A queue barrier finishes/recover-fences earlier writes before absence is reported.
  const snapshot = await lifecycle.resolveMutation(operationId);
  if (requireRouteCatalogLifecycle() !== lifecycle) throw new Error("Route catalog lifecycle changed during recovery.");
  if (snapshot.resolvedMutation?.operationId !== operationId) throw new Error("Route mutation resolution is unavailable.");
  return { state: snapshot.resolvedMutation.state };
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  return sharedNormalizeGatewayDefinition(definition, {
    managerPort,
    routeDataDir: (configName) => path.relative(rootDir, routeFolderPath(managerRouteRoot(), configName)).replace(/\\/g, "/"),
    rolesDir: path.relative(rootDir, managerRolesRoot()).replace(/\\/g, "/"),
    normalizeAgentAdapters: (adapters) => normalizeAgentAdapters(adapters),
    normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
  }) as GatewayDefinition;
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

function personaConfigPath(roleId: string): string {
  return resolvePersonaConfigPath(managerRolesRoot(), roleId);
}

function adapterConfigPath(configName: string): string {
  return resolveAdapterConfigPath(managerRouteRoot(), configName);
}

function configPathValue(value: unknown): string | undefined {
  return toPersistedProjectPath(value, rootDir);
}

export function adapterConfigItem(definition: GatewayDefinition): Record<string, unknown> {
  const usesNapcat = sharedDefinitionUsesNapcat(definition);
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
    personaAutomationScriptsEnabled: true,
    remoteAgentDefaultDeviceId: definition.remoteAgentDefaultDeviceId,
    remoteAgentDefaultCwd: configPathValue(definition.remoteAgentDefaultCwd),
    remoteAgentDefaultThreadName: definition.remoteAgentDefaultThreadName,
    agentModel: definition.agentModel,
    agentReasoningEffort: definition.agentReasoningEffort,
    codexThreadId: definition.codexThreadId,
    codexThreadName: definition.codexThreadName,
    codexCwd: configPathValue(definition.codexCwd),
    remoteAgentTargets: definition.remoteAgentTargets,
    primaryAgentTarget: definition.primaryAgentTarget,
    agentRecipients: definition.agentRecipients,
    dshSessionId: definition.dshSessionId,
    dshSessionName: definition.dshSessionName,
    dshCwd: configPathValue(definition.dshCwd),
    dshBaseUrl: definition.dshBaseUrl,
    dshAgentPreset: definition.dshAgentPreset,
    codexPlanAssistantEnabled: definition.codexPlanAssistantEnabled,
    codexPlanAssistantModel: definition.codexPlanAssistantModel,
    codexPlanAssistantSessions: definition.codexPlanAssistantSessions,
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
    grokBotProfilePath: definition.grokBotProfilePath,
    grokBotBackendUrl: definition.grokBotBackendUrl,
    grokBotAgentId: definition.grokBotAgentId,
    grokBotSessionId: definition.grokBotSessionId,
    grokBotSessionName: definition.grokBotSessionName,
    rolesDir: configPathValue(definition.rolesDir),
    agentRoleId: definition.agentRoleId,
    agentRoleDeviceId: definition.agentRoleDeviceId,
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
    speechServiceUrl: globalRelay.speechServiceUrl
  };
}

function firstRouteLevelRabiLinkRelayConfig(): RabiLinkRelayGlobalConfig | null {
  const globalConfig = rabiGlobalConfig.read();
  for (const runtime of runtimes.values()) {
    const definition = runtime.definition;
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

const rabiLinkDeviceConnections = new RabiLinkDeviceConnections({
  dataDir: path.join(rootDir, "data", "rabilink"),
  readOnly: managerReadOnly,
  scope: () => rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()),
  readConnections: async () => {
    const relay = rabiLinkRelayConfigForMeta();
    const response = await fetch(`${relay.url.replace(/\/+$/, "")}/api/rabilink/devices/connections`, {
      headers: { "x-rabilink-token": relay.token }, redirect: "error", signal: AbortSignal.timeout(getTimeoutMs("backend.manager.controlPlaneRoutes.readConnections.AbortSignal.timeout.request", 5_000))
    });
    if (!response.ok) throw Object.assign(new Error("CONNECTION_DIRECTORY_UNAVAILABLE"), { statusCode: 503 });
    const value = await response.json() as { data?: import("./rabiLinkDeviceConnections.js").ConnectionDirectory };
    if (!value.data) throw Object.assign(new Error("CONNECTION_DIRECTORY_INVALID"), { statusCode: 503 });
    return value.data;
  }
});
function rabiLinkRequestLocal(pathname: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\#\r\n\0]/.test(pathname)) throw new Error("LOCAL_MANAGER_PATH_INVALID");
  return fetch(managerBaseUrl + pathname, {
    method, redirect: "error", signal: AbortSignal.timeout(getTimeoutMs("backend.manager.controlPlaneRoutes.rabiLinkRequestLocal.AbortSignal.timeout.request", 30_000)),
    headers: { ...headers, "x-rabiroute-expected-generation": managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
      ...(body === undefined || ["GET", "HEAD"].includes(method) ? {} : { "content-type": "application/json" }) },
    ...(body === undefined || ["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body) })
  });
}
async function rabiLinkReadResponse(response: Response): Promise<any> {
  const value = await response.json() as { code?: number; data?: unknown };
  if (!response.ok || value.code !== undefined && value.code !== 0) throw Object.assign(new Error("MANAGER_READ_FAILED"), { code: "MANAGER_READ_FAILED", statusCode: response.ok ? 502 : response.status });
  return value.data ?? value;
}
let rabiLinkBusinessOwners: { key: string; agents: ReturnType<typeof createRabiLinkAgentDevices> } | undefined;
async function assertCurrentDeviceAgentAssignment(scope: string, agentId: string): Promise<void> {
  const config = rabiLinkRelayConfigForMeta();
  if (scope !== rabiLinkConnectionScope(config)) throw Object.assign(new Error("DEVICE_AGENT_CONNECTION_CHANGED"), { code: "DEVICE_AGENT_CONNECTION_CHANGED", statusCode: 401 });
  const owner = await rabiLinkDeviceConnections.deviceTarget(agentId);
  if (scope !== rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()) || owner !== config.deviceId) {
    throw Object.assign(new Error("DEVICE_AGENT_OWNER_MISMATCH"), { code: "DEVICE_AGENT_OWNER_MISMATCH", statusCode: 409 });
  }
}
async function requestPeerManagerApi(targetDeviceId: string, method: string, pathname: string, body?: unknown): Promise<unknown> {
  return withPeerManagerResponse(targetDeviceId, method, pathname, body, rabiLinkReadResponse);
}
async function requestPeerManagerResult(targetDeviceId: string, method: string, pathname: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return withPeerManagerResponse(targetDeviceId, method, pathname, body, async response => ({
    status: response.status, body: await response.json() as Record<string, unknown>
  }));
}
async function withPeerManagerResponse<T>(targetDeviceId: string, method: string, pathname: string, body: unknown,
  readResponse: (response: Response) => Promise<T>): Promise<T> {
  const original = rabiLinkRelayConfigForMeta(), scope = rabiLinkConnectionScope(original);
  const peer = activePeerTunnel, ownerInstanceId = rabiGlobalConfig.read().rabiGuid;
  if (!scope) throw Object.assign(new Error("DEVICE_AGENT_CONNECTION_CHANGED"), { statusCode: 401 });
  const assertCurrent = () => {
    const current = rabiLinkRelayConfigForMeta();
    if (scope !== rabiLinkConnectionScope(current) || original.deviceId !== current.deviceId
      || ownerInstanceId !== rabiGlobalConfig.read().rabiGuid || peer !== activePeerTunnel) {
      throw Object.assign(new Error("DEVICE_AGENT_CONNECTION_CHANGED"), { statusCode: 401 });
    }
  };
  assertCurrent();
  const response = targetDeviceId === original.deviceId
    ? await rabiLinkRequestLocal(pathname, method, body)
    : peer ? await peer.fetch(targetDeviceId, "manager", pathname, {
        method, signal: AbortSignal.timeout(getTimeoutMs("backend.manager.controlPlaneRoutes.requestDeviceAgentPeerApi.AbortSignal.timeout.request", 30_000)),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      }) : undefined;
  assertCurrent();
  if (!response) throw Object.assign(new Error("DEVICE_AGENT_PEER_UNAVAILABLE"), { statusCode: 503 });
  const value = await readResponse(response);
  assertCurrent();
  return value;
}
function deviceAgentHostContext(endpointManagerInstanceId: string) {
  const config = rabiLinkRelayConfigForMeta();
  const sourceDeviceGuid = rabiGlobalConfig.read().rabiGuid;
  const key = JSON.stringify([config.deviceId, sourceDeviceGuid, rabiLinkConnectionScope(config), managerHostIdentity?.applicationGenerationId ?? managerInstanceId]);
  const authorize = (request: http.IncomingMessage) => rabiLinkAgentDevicePrincipal(request, rabiLinkRelayConfigForMeta(), managerHostIdentity?.applicationGenerationId ?? managerInstanceId);
  const peerAuthority = createDeviceAgentPeerAuthority({
    scope: () => rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()),
    localDeviceId: () => rabiLinkRelayConfigForMeta().deviceId, authorize,
    trustedTransport: request => rabiLinkTrustedTransport(request, managerHostIdentity?.applicationGenerationId ?? managerInstanceId, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())),
    readProof: (id, deliveryId, generation) => requestPeerManagerApi(id, "GET", "/api/agent/delivery-authority?" + new URLSearchParams({ deliveryId, generation }))
  });
  const ownerOptions: DeviceAgentOwnerOptions = {
    dataDir: path.join(rootDir, "data", "rabilink"), ownerInstanceId: sourceDeviceGuid, authorize,
    assertCurrent: () => {
      const config = rabiLinkRelayConfigForMeta();
      const currentKey = JSON.stringify([config.deviceId, rabiGlobalConfig.read().rabiGuid, rabiLinkConnectionScope(config), managerHostIdentity?.applicationGenerationId ?? managerInstanceId]);
      if (key !== currentKey) throw Object.assign(new Error("DEVICE_AGENT_CONNECTION_CHANGED"), { code: "DEVICE_AGENT_CONNECTION_CHANGED", statusCode: 401 });
    },
    connectionContextAvailable: () => Boolean(rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())),
    authorizePrepared: peerAuthority.authorizePrepared,
    authorizePreparedClaim: peerAuthority.authorizePreparedClaim,
    authorizeDelivery: async (request, agentId) => deviceAgentDeliveryPrincipal(request, agentId, {
      authorize,
      ownerInstanceId: () => rabiGlobalConfig.read().rabiGuid,
    }),
    assertDeviceAssignment: assertCurrentDeviceAgentAssignment
  };
  return { key, ownerOptions, endpointOptions: {
    managerInstanceId: endpointManagerInstanceId,
    ownerInstanceId: sourceDeviceGuid,
    scope: () => rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()),
    assertDeviceAssignment: assertCurrentDeviceAgentAssignment,
    peer: {
      localDeviceId: () => rabiLinkRelayConfigForMeta().deviceId,
      targetDeviceId: (id: string) => rabiLinkDeviceConnections.deviceTarget(id),
      request: requestPeerManagerApi
    }
  } };
}
function currentRabiLinkBusinessOwners() {
  const sourceDeviceId = rabiLinkRelayConfigForMeta().deviceId, sourceDeviceGuid = rabiGlobalConfig.read().rabiGuid;
  const key = JSON.stringify([sourceDeviceId, sourceDeviceGuid, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()), managerHostIdentity?.applicationGenerationId ?? managerInstanceId]);
  if (rabiLinkBusinessOwners?.key === key) return rabiLinkBusinessOwners;
  const authorize = (request: http.IncomingMessage) => rabiLinkAgentDevicePrincipal(request, rabiLinkRelayConfigForMeta(), managerHostIdentity?.applicationGenerationId ?? managerInstanceId);
  const agents = createRabiLinkAgentDevices({
    dataDir: path.join(rootDir, "data", "rabilink"), sourceDeviceId, authorize,
    assertCurrent: () => {
      const config = rabiLinkRelayConfigForMeta();
      const currentKey = JSON.stringify([config.deviceId, rabiGlobalConfig.read().rabiGuid, rabiLinkConnectionScope(config), managerHostIdentity?.applicationGenerationId ?? managerInstanceId]);
      if (key !== currentKey) throw Object.assign(new Error("PROFILE_CONNECTION_CHANGED"), { code: "PROFILE_CONNECTION_CHANGED", statusCode: 401 });
    },
    connectionContextAvailable: () => Boolean(rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())),
    deviceOwnerTarget: id => rabiLinkDeviceConnections.deviceTarget(id),
    readLocal: pathname => rabiLinkRequestLocal(pathname).then(rabiLinkReadResponse),
    readTarget: async (id, pathname) => {
      if (id === sourceDeviceId) return rabiLinkReadResponse(await rabiLinkRequestLocal(pathname));
      if (!activePeerTunnel) throw Object.assign(new Error("PERSONA_SOURCE_UNAVAILABLE"), { statusCode: 503 });
      return rabiLinkReadResponse(await activePeerTunnel.fetch(id, "manager", pathname, { signal: AbortSignal.timeout(getTimeoutMs("backend.manager.controlPlaneRoutes.readTarget.AbortSignal.timeout.request", 30_000)) }));
    }
  });
  return rabiLinkBusinessOwners = { key, agents };
}

async function syncRabiLinkRelayRuntime(onLanReady?: () => void | Promise<void>): Promise<void> {
  if (!managerShouldAutostart) {
    await Promise.all([
      peerLanServer.stop(),
      rabiLinkRelayRuntime.stop()
    ]);
    return;
  }
  const globalConfig = rabiGlobalConfig.read();
  const relay = rabiLinkRelayConfigForMeta();
  const lanEnabled = relay.enabled && Boolean(relay.url.trim()) && Boolean(relay.token.trim());
  if (!lanEnabled) await peerLanServer.stop();
  await rabiLinkRelayRuntime.sync({
    ...relay,
    deviceGuid: globalConfig.rabiGuid,
    deviceName: globalConfig.rabiName || os.hostname(),
    rabiPcVersion: rabiRoutePackageVersion(),
    localWebguiUrl: `http://127.0.0.1:${managerPort}`,
    applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    peerUrls: lanEnabled ? peerLanServer.peerUrls() : [],
    localSpeechUrl: relay.speechServiceUrl
  });
  if (lanEnabled && peerLanServer.status().state !== "listening") {
    try {
      await peerLanServer.start();
    } catch (error) {
      console.warn(`Peer LAN listener unavailable; Relay fallback remains active: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await onLanReady?.();
  }
}

async function writeAdapterConfigFile(definition: GatewayDefinition): Promise<void> {
  messageEndpointManagers.validateRoutes([...readConfig().gateways.filter(item => item.id !== definition.id), definition], readConfig().gateways);
  const desired = structuredClone(definition);
  const committed = readConfig().gateways.find(item => item.id === desired.id);
  const live = runtimes.get(desired.id);
  if (committed && live?.definition === definition) {
    live.definition = structuredClone(committed);
  }
  try {
    await requireRouteCatalogLifecycle().upsert(desired);
    pendingManagedConfigWatchEchoes += 1;
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}









async function ensurePersonaConfigFile(roleId: string): Promise<string> {
  const configPath = personaConfigPath(roleId);
  try {
    await requireRouteCatalogLifecycle().ensurePersona(roleId);
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
  return configPath;
}

async function ensureRoleFile(roleId: string, roleFile: string): Promise<string> {
  const target = roleFilePath(managerRolesRoot(), roleId, roleFile);
  try {
    await requireRouteCatalogLifecycle().ensureRoleFile(roleId, roleFile);
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
  return target;
}

async function ensureRoleFolder(roleId: string, subfolder?: string): Promise<string> {
  const target = roleFolderPath(managerRolesRoot(), roleId, subfolder);
  try {
    await requireRouteCatalogLifecycle().ensureRoleFolder(roleId, subfolder);
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
  return target;
}

async function reconcilePersistedPlanSecretaryWorkspaces(): Promise<void> {
  const ownerByRoleDir = new Map<string, { roleDir: string; roleId: string; workspace: string; agentTargetId: string; conflicting: boolean }>();
  for (const runtime of runtimes.values()) {
    if (runtime.definition.agentRoleDeviceId) continue;
    const target = resolvePrimaryAgentTarget(runtime.definition);
    const workspace = primaryAgentWorkspace(runtime.definition)?.trim();
    if (!target || !workspace) continue;
    const roleDir = roleDirForDefinition(runtime.definition);
    const roleId = roleIdForDefinition(runtime.definition);
    const key = `${path.resolve(roleDir).toLowerCase()}\0${target.id}`;
    const existing = ownerByRoleDir.get(key);
    if (!existing) {
      ownerByRoleDir.set(key, { roleDir, roleId, workspace, agentTargetId: target.id, conflicting: false });
      continue;
    }
    if (!sameCodexWorkspace(existing.workspace, workspace)) existing.conflicting = true;
  }

  for (const [roleDirKey, owner] of ownerByRoleDir) {
    if (owner.conflicting) {
      console.warn(`Plan secretary workspace reconciliation skipped because ${roleDirKey} has multiple Primary Persona workspaces.`);
      continue;
    }
    try {
      const plans = (await currentRoleStorageApplication().queries.recaptureCatalog(
        owner.roleId,
        { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.reconcilePersistedPlanSecretaryWorkspaces.currentRoleStorageApplication__.queries.recaptureCatalog.timeoutMs", 30_000) }
      )).plans;
      const stalePlanIds: string[] = [];
      reconcilePlanSecretaryBindingsForWorkspace(
        plans,
        owner.workspace,
        (planId) => { stalePlanIds.push(planId); },
        owner.agentTargetId
      );
      for (const planId of stalePlanIds) {
        const projection = await currentRoleStorageApplication().queries.plan(owner.roleId, planId, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.reconcilePersistedPlanSecretaryWorkspaces.currentRoleStorageApplication__.queries.plan.timeoutMs", 30_000) });
        if (!projection) continue;
        await currentRoleStorageApplication().commands.updatePlanSecretaryBinding(owner.roleId, planId, null, {
          idempotencyKey: roleStorageOperationKey(
            "workspace-reconcile",
            owner.workspace,
            planId,
            projection.revision
          ),
          expectedRevision: projection.revision,
          timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.reconcilePersistedPlanSecretaryWorkspaces.currentRoleStorageApplication__.commands.updatePlanSecretaryBinding.timeoutMs", 30_000)
        });
      }
    } catch (error) {
      console.warn(`Plan secretary workspace reconciliation failed for ${owner.roleDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const gatewayRuntimePluginLease = new GenerationHandoffLease();
let gatewayListenerPublicationHost: ReturnType<typeof createGatewayListenerPublicationHost> | undefined;
const gatewayListenerDetachers = new WeakMap<ChildProcessWithoutNullStreams, () => void>();
let gatewayRouteDeclarationPackages: LoadedPluginProfile["packages"] = [];
let installedGatewayEndpointTypes: ReadonlySet<string> = new Set();
let installedEndpointRouteDeclarations: readonly EndpointRouteConfigDeclaration[] = [];
const gatewayRouteActivations = createGatewayRouteActivationOwner({
  timeoutMs: () => getTimeoutMs("backend.manager.gatewayRouteSnapshot.ack", 30_000),
  declarations: async () => mergeEndpointRouteDeclarations((await readEndpointRouteDeclarations(gatewayRouteDeclarationPackages)).declarations, installedEndpointRouteDeclarations)
});
const routeMutationActivation = (operationId: string) => gatewayRouteActivations.receipt(operationId);

const gatewayRuntimeService = new ManagerGatewayRuntimeService<GatewayDefinition, GatewayRuntime>(runtimes, {
  loadDefinitions: () => readConfig().gateways,
  normalizeDefinition,
  definitionFingerprint,
  createRuntime: definition => ({
    definition,
    process: null,
    needsRestart: false,
    startedAt: null,
    stoppedAt: null,
    lastExit: null,
    readiness: "stopped",
    endpoints: [],
    lastError: null,
    log: []
  }),
  isRunning: runtime => Boolean(runtime.process),
  reconcileAction: runtime => gatewayRuntimeSyncAction({
    managerShouldAutostart,
    enabled: runtime.definition.enabled === true,
    // A native owner may still be draining accepted work after its package is disabled.
    runtimeRequired: Boolean(runtime.process) || sharedGatewayMessageAdapterTypes(runtime.definition, installedGatewayEndpointTypes).length > 0,
    running: Boolean(runtime.process),
    needsRestart: runtime.needsRestart
  }),
  startRuntime: runtime => startGatewayRuntime(runtime.definition.id),
  stopRuntime: runtime => stopGatewayRuntime(runtime.definition.id),
  onRuntimeError: (runtime, error, action) => {
    const message = error instanceof Error ? error.message : String(error);
    // These facts belong to the original runtime before any fallible console/log observer.
    runtime.lastError = message;
    if (!runtime.process) runtime.readiness = "failed";
    runtimes.appendLog(runtime, `${action} failed: ${message}`);
    const reportFailures: unknown[] = [];
    try { console.error(`[${runtime.definition.id}] ${action} failed: ${message}`); }
    catch (reportError) { reportFailures.push(reportError); }
    try {
      managerOperationalLog.record("error", "gateway_runtime_action_failed", {
        routeId: runtime.definition.id,
        childPid: runtime.process?.pid,
        action,
        result: runtime.process ? "process_still_owned" : "not_running",
        error: managerOperationalError(error, rootDir)
      });
    } catch (reportError) { reportFailures.push(reportError); }
    if (reportFailures.length) throw new AggregateError(reportFailures, "Gateway runtime error reporting failed.");
  },
  restartRuntime: runtime => {
    if (!runtime.process) {
      startGatewayRuntime(runtime.definition.id);
      return;
    }
    runtime.needsRestart = true;
    appendLog(runtime, "restarting because gateway config changed");
    runtime.process.kill();
  }
});

async function loadRuntimes(): Promise<void> {
  try {
    await requireRouteCatalogLifecycle().recapture();
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}



async function applyRouteCatalogSnapshot(snapshot: RouteCatalogSnapshot, application: RouteCatalogApplicationContext): Promise<void> {
  if (
    normalizePathForComparison(snapshot.routeRoot) !== normalizePathForComparison(managerRouteRoot())
    || normalizePathForComparison(snapshot.rolesRoot) !== normalizePathForComparison(managerRolesRoot())
  ) {
    throw new Error("Route catalog snapshot roots no longer match the active Manager configuration.");
  }
  const normalized = snapshot.gateways.map(definition => normalizeDefinition(
    structuredClone(definition) as GatewayDefinition
  ));
  const ids = new Set<string>();
  for (const definition of normalized) {
    if (ids.has(definition.id)) throw new Error(`Duplicate route catalog id: ${definition.id}`);
    ids.add(definition.id);
  }
  sharedValidateGatewayPortConflicts(normalized);
  await messageEndpointManagers.reconcileRoutes(normalized);
  gatewayRuntimeService.loadDefinitions(normalized);
  routeCatalogConfig = { gateways: structuredClone(normalized) };
  routeCatalogPersonaPresentations = Object.freeze(snapshot.personas.map(item => Object.freeze({
    ...structuredClone(item),
    files: Object.freeze(item.files.map(file => Object.freeze({ ...file }))),
    speech: Object.freeze({ ...item.speech })
  })));
  agentRequestRouteReconciliation.request();
  // The catalog CAS queue already serializes this await. Endpoint ownership supplies the only live candidate configuration.
  await gatewayRouteActivations.prepare(runtimes.values(), application.resolveOperationId ?? application.operationId, Boolean(application.resolveOperationId), application.kind !== "capture");
  syncRunningGateways();
}

function syncRunningGateways(): void {
  if (!gatewayRuntimePluginLease.active) return;
  const startup = routeCatalogStartupStatus();
  if (!isRouteCatalogSnapshotInstalled(startup) || !["ready", "running", "degraded"].includes(startup.state)) return;
  gatewayRuntimeService.reconcile();
}

async function reloadChangedConfig(
  reason: string,
  reconcileManagerPlugins?: (reason: string) => Promise<void>,
  afterReload?: () => void | Promise<void>
): Promise<void> {
  try {
    configRepository.refreshManagerConfig();
    const routeCatalogLifecycle = activeStorageLifecycleGeneration?.routeCatalog;
    if (!routeCatalogLifecycle) throw new Error("Route catalog lifecycle is unavailable.");
    await routeCatalogLifecycle.recapture();
    await reconcilePersistedPlanSecretaryWorkspaces();
  } catch (error) {
    console.error(`Failed to reload gateway config ${reason}`, error);
  }
  if (reconcileManagerPlugins) {
    try {
      await reconcileManagerPlugins(reason);
    } catch (error) {
      console.error(`Failed to reconcile Manager plugins ${reason}`, error);
    }
  }
  try {
    syncRunningGateways();
    await afterReload?.();
    memoryConsolidationScheduler?.reschedule();
    console.log(`gateway-manager reloaded ${reason}`);
  } catch (error) {
    console.error(`Failed to apply reloaded Manager config ${reason}`, error);
  }

}

type ConfigWatcher = Pick<ManagerWatchBroker, "close">;
type PluginPackageWatcher = Pick<ManagerWatchBroker, "close">;

function recordWatchDiagnostic(source: "config" | "plugin_tree", diagnostic: ManagerWatchDiagnostic): void {
  const { status } = diagnostic;
  managerOperationalLog.record(diagnostic.event === "manager_watch_degraded" ? "warn" : "info", diagnostic.event, {
    source,
    owner: "ManagerWatchBroker",
    operationId: `${managerInstanceId}:${source}:${status.attempts}`,
    childPid: status.activeWorkerPid,
    durationMs: diagnostic.durationMs,
    result: `previous=${diagnostic.previousState}; state=${status.state}; attempt=${status.attempts}; timeoutMs=${diagnostic.timeoutMs}; timeouts=${status.timeouts}; restarts=${status.restarts}; errors=${status.errors.length}; lastSuccessAt=${status.lastSuccessAt ?? "never"}`,
    action: managerOperationalError(new Error(diagnostic.reason), rootDir)?.message,
    error: diagnostic.error ? managerOperationalError(diagnostic.error, rootDir) : undefined
  });
}

function startPluginPackageWatcher(
  directories: readonly string[],
  reconcile: (reason: string) => Promise<void>
): PluginPackageWatcher {
  let initialized = false;
  let snapshot = "";
  const broker = new ManagerWatchBroker({
    request: { kind: "plugin_tree", roots: directories },
    debounceMs: 160,
    onStatus: status => { pluginPackageWatchLifecycle = status; },
    onDiagnostic: diagnostic => recordWatchDiagnostic("plugin_tree", diagnostic),
    onSnapshot: async result => {
      if (result.partial) {
        console.warn(`Plugin watch snapshot is partial (${result.errors.length} unavailable path(s)); Manager remains online.`);
      }
      if (!initialized) {
        initialized = true;
        snapshot = result.snapshot;
        return;
      }
      if (result.snapshot === snapshot) return;
      snapshot = result.snapshot;
      try {
        await reconcile("plugin profile or bundle changed");
      } catch (error) {
        console.warn("Plugin bundle reload failed; the active revision remains in service.", error);
        throw error;
      }
    }
  });
  broker.start();
  return broker;
}

function startConfigWatcher(
  reconcileManagerPlugins?: (reason: string) => Promise<void>,
  afterReload?: () => void | Promise<void>
): ConfigWatcher {
  let initialized = false;
  const broker = new ManagerWatchBroker({
    request: () => ({
      kind: "config",
      routeRoot: managerRouteRoot(),
      rolesRoot: managerRolesRoot(),
      operationTimeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.request.operationTimeoutMs", 1_500),
      explicitFiles: [configRepository.managerConfigPath]
    }),
    onStatus: status => { configWatchLifecycle = status; },
    onDiagnostic: diagnostic => recordWatchDiagnostic("config", diagnostic),
    onSnapshot: async (result, reason) => {
      if (result.partial) {
        console.warn(`Config watch snapshot is partial (${result.errors.length} unavailable path(s)); Manager remains online.`);
      }
      if (initialized && result.snapshot !== watchedConfigSnapshot) {
        watchedConfigSnapshot = result.snapshot;
        if (pendingManagedConfigWatchEchoes > 0) {
          pendingManagedConfigWatchEchoes -= 1;
          broker.requestRefresh("after managed route catalog write");
          return;
        }
        await reloadChangedConfig(reason, reconcileManagerPlugins, afterReload);
        broker.requestRefresh("after config root refresh");
      } else {
        watchedConfigSnapshot = result.snapshot;
        initialized = true;
      }
    }
  });
  broker.start();
  return broker;
}

function appendLog(runtime: GatewayRuntime, line: string): void {
  runtimes.appendLog(runtime, line);
  console.log(`[${runtime.definition.id}] ${line}`);
}

function childCommand(extraArgs: string[] = []) {
  return resolveGatewayChildCommand(packageRoot, extraArgs);
}

function reconcileActiveSpeech(): void {
  const service = resolvePublishedPluginService("manager.speech@1") as PublishedSpeechService | undefined;
  service?.reconcile("manager startup");
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

function envFor(
  definition: GatewayDefinition,
  adapterEnvironment: MessageAdapterEnvironment = routeMessageAdapterEnvironment(sharedGatewayAdapterTypes(definition))
): NodeJS.ProcessEnv {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  const routeDataDir = path.relative(rootDir, routeFolderPath(managerRouteRoot(), configName)).replace(/\\/g, "/");
  const routeRolesDir = path.relative(rootDir, managerRolesRoot()).replace(/\\/g, "/");
  const rabiLinkRelay = rabiLinkRelayConfigFor(definition);
  const globalConfig = rabiGlobalConfig.read();
  const {
    RABIROUTE_HOST_CONTROL_TOKEN: _hostControlToken,
    ...gatewayBaseEnvironment
  } = process.env;
  return {
    ...gatewayBaseEnvironment,
    GATEWAY_ID: definition.id,
    RABI_GUID: globalConfig.rabiGuid,
    GATEWAY_MANAGER_PORT: String(managerPort),
    GATEWAY_MANAGER_URL: `http://127.0.0.1:${managerPort}`,
    RABIROUTE_APPLICATION_GENERATION_ID: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    RABIROUTE_MANAGER_INSTANCE_ID: managerInstanceId,
    PERSONA_MESSAGING_CAPABILITY: currentPersonaMessageAuthority().issue(definition.id, roleIdForDefinition(definition)),
    ...adapterEnvironment,
    MESSAGE_ADAPTER_POLICIES: JSON.stringify(definition.messageAdapterPolicies ?? {}),
    AGENT_MODEL: definition.agentModel?.trim() || "",
    AGENT_REASONING_EFFORT: definition.agentReasoningEffort ?? "",
    DSH_MODEL_PROVIDER: definition.dshModelProvider?.trim() || "",
    DSH_MODEL: definition.dshModel?.trim() || "",
    DSH_REASONING_EFFORT: definition.dshReasoningEffort?.trim() || "",
    RABI_DSH_ROUTE_CONFIG_PATH: adapterConfigPath(configName),
    MESSAGE_PROCESSING_AGENTS: JSON.stringify(definition.messageProcessingAgents ?? {}),
    AGENT_RECIPIENTS: JSON.stringify(definition.agentRecipients ?? []),
    PIPELINE_PRESET: definition.pipelinePreset ?? "",
    PIPELINE: definition.pipeline ? JSON.stringify(definition.pipeline) : "",
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。",
    HEARTBEAT_SKIP_WHEN_AGENT_BUSY: definition.heartbeatSkipWhenAgentBusy ? "1" : "0",
    PERSONA_AUTOMATION_SCRIPTS_ENABLED: "1",
    REMOTE_AGENT_DEFAULT_DEVICE_ID: definition.remoteAgentDefaultDeviceId?.trim() || "",
    REMOTE_AGENT_DEFAULT_CWD: configPathValue(definition.remoteAgentDefaultCwd) || "",
    REMOTE_AGENT_DEFAULT_THREAD_NAME: definition.remoteAgentDefaultThreadName?.trim() || "",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_WEBUI_URL: definition.napcatWebuiUrl ?? process.env.NAPCAT_WEBUI_URL ?? "http://127.0.0.1:6099/webui",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    NAPCAT_WEBUI_TOKEN: definition.napcatWebuiToken ?? process.env.NAPCAT_WEBUI_TOKEN ?? "",
    NAPCAT_INSTANCES: JSON.stringify(definition.napcatInstances ?? sharedNormalizeNapCatInstances(definition)),
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
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
    WECOM_BOT_ID: definition.wecomBotId === undefined ? process.env.WECOM_BOT_ID || "" : definition.wecomBotId.trim(),
    WECOM_BOT_SECRET: definition.wecomBotSecret === undefined ? process.env.WECOM_BOT_SECRET || "" : definition.wecomBotSecret.trim(),
    WECOM_WS_URL: definition.wecomWsUrl === undefined ? process.env.WECOM_WS_URL || "" : definition.wecomWsUrl.trim(),
    WEIXIN_BASE_URL: definition.weixinBaseUrl?.trim() || process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com",
    WEIXIN_BOT_TYPE: definition.weixinBotType?.trim() || process.env.WEIXIN_BOT_TYPE || "3",
    FEISHU_APP_ID: definition.feishuAppId === undefined ? process.env.FEISHU_APP_ID || "" : definition.feishuAppId.trim(),
    FEISHU_APP_SECRET: definition.feishuAppSecret === undefined ? process.env.FEISHU_APP_SECRET || "" : definition.feishuAppSecret.trim(),
    FEISHU_VERIFICATION_TOKEN: definition.feishuVerificationToken === undefined ? process.env.FEISHU_VERIFICATION_TOKEN || "" : definition.feishuVerificationToken.trim(),
    FEISHU_ENCRYPT_KEY: definition.feishuEncryptKey === undefined ? process.env.FEISHU_ENCRYPT_KEY || "" : definition.feishuEncryptKey.trim(),
    FEISHU_EVENT_SUBSCRIPTION_ENABLED: definition.feishuEventSubscriptionEnabled === true ? "true" : "false",
    FEISHU_WEBHOOK_PORT: String(definition.feishuWebhookPort ?? definition.gatewayPort),
    FEISHU_WEBHOOK_PATH: definition.feishuWebhookPath ?? "/feishu",
    CODEX_THREAD_ID: definition.primaryAgentAdapter === "dsh"
      ? (definition.dshSessionId?.trim() || definition.codexThreadId?.trim() || "")
      : (definition.codexThreadId?.trim() || ""),
    CODEX_THREAD_NAME: resolveCodexThreadName(definition),
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? normalizeCodexCwd(process.env.CODEX_CWD) ?? rootDir,
    AGENT_INSTANCE_BINDINGS: JSON.stringify(primaryAgentInstanceBindings(definition) || {}),
    REMOTE_AGENT_TARGETS: JSON.stringify(definition.remoteAgentTargets || []),
    PRIMARY_AGENT_TARGET: normalizeRouteAgentTargets(definition).primaryAgentTarget ?? "",
    LAN_AGENT_ACCESS_TOKEN: resolvePrimaryAgentTarget(definition)?.binding ? globalConfig.webguiLan.accessToken : "",
    DSH_SESSION_ID: definition.dshSessionId?.trim() || "",
    DSH_SESSION_NAME: definition.dshSessionName?.trim() || "",
    DSH_BASE_URL: definition.dshBaseUrl?.trim() || "",
    DSH_CWD: normalizeCodexCwd(definition.dshCwd) || "",
    CODEX_PLAN_ASSISTANT_ENABLED: definition.codexPlanAssistantEnabled === true ? "true" : "false",
    CODEX_PLAN_ASSISTANT_MODEL: normalizeCodexPlanAssistantModel(definition.codexPlanAssistantModel),
    CODEX_PLAN_ASSISTANT_SESSIONS: JSON.stringify(definition.codexPlanAssistantSessions ?? []),
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
    GROK_BOT_PROFILE_PATH: definition.grokBotProfilePath?.trim() || process.env.GROK_BOT_PROFILE_PATH || "",
    GROK_BOT_BACKEND_URL: definition.grokBotBackendUrl?.trim() || process.env.GROK_BOT_BACKEND_URL || "",
    GROK_BOT_AGENT_ID: definition.grokBotAgentId?.trim() || process.env.GROK_BOT_AGENT_ID || "",
    GROK_BOT_SESSION_ID: definition.grokBotSessionId?.trim() || process.env.GROK_BOT_SESSION_ID || "",
    GROK_BOT_SESSION_NAME: definition.grokBotSessionName?.trim() || process.env.GROK_BOT_SESSION_NAME || "",
    ROLES_DIR: routeRolesDir,
    AGENT_ROLE_ID: sanitizeRoleId(definition.agentRoleId),
    AGENT_ROLE_DEVICE_ID: definition.agentRoleDeviceId || "",
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

function startGatewayRuntime(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const startup = routeCatalogStartupStatus();
  if (!isRouteCatalogSnapshotInstalled(startup) || !["ready", "running", "degraded"].includes(startup.state)) {
    runtime.readiness = "blocked";
    runtime.lastError = "Route catalog startup is not ready.";
    appendLog(runtime, "skip start until route catalog startup is ready");
    return;
  }
  const runtimeAdapters = sharedGatewayMessageAdapterTypes(runtime.definition, installedGatewayEndpointTypes);
  const startDecision = gatewayRuntimeStartDecision({
    enabled: runtime.definition.enabled === true,
    runtimeRequired: runtimeAdapters.length > 0,
    running: Boolean(runtime.process && !runtime.process.killed)
  });
  if (startDecision === "skip-disabled") {
    appendLog(runtime, "skip start because gateway is disabled");
    return;
  }
  if (startDecision === "skip-not-required") {
    appendLog(runtime, "skip start because Route has no Gateway-owned message adapters");
    return;
  }
  if (startDecision === "already-running") {
    return;
  }

  const command = childCommand();
  const agentStateGeneration = randomUUID();
  const routeBoot = writeGatewayRouteBootSnapshot(path.join(dataDirFor(runtime.definition), ".rabi-runtime", "route-snapshots"), agentStateGeneration, runtime.definition);
  const releaseRouteBoot = () => {
    try { routeBoot.dispose(); }
    catch (error) {
      // Cleanup runs in child event callbacks too; its diagnostic cannot escape those callbacks.
      runtime.log.push(`[${new Date().toISOString()}] Gateway boot Route snapshot cleanup failed: ${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}`);
      if (runtime.log.length > 200) runtime.log.splice(0, runtime.log.length - 200);
    }
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    const childEnv = envFor(routeBoot.definition, gatewayMessageAdapterEnvironment(runtimeAdapters));
    childEnv.RABIROUTE_ROUTE_SNAPSHOT_PATH = routeBoot.filename;
    childEnv.RABIROUTE_ROUTE_REVISION = routeBoot.revision;
    childEnv.AGENT_STATE_GENERATION = agentStateGeneration;
    childEnv.RABIROUTE_GATEWAY_GENERATION_ID = agentStateGeneration;
    child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: childEnv,
      shell: command.shell,
      windowsHide: true
    });
  } catch (error) {
    releaseRouteBoot();
    throw error;
  }
  runtime.agentStateGeneration = agentStateGeneration;
  agentStateByGateway.delete(runtime.definition.id);
  child.once("close", () => { gatewayRouteActivations.detach(child); releaseRouteBoot(); });
  child.once("error", releaseRouteBoot);

  if (child.pid && gatewayListenerPublicationHost) {
    gatewayListenerDetachers.set(child, gatewayListenerPublicationHost.attach(child, {
      gatewayId: runtime.definition.id,
      gatewayGenerationId: agentStateGeneration
    }));
  }

  runtime.log = [];
  runtime.process = child;
  runtime.readiness = "starting";
  runtime.endpoints = [];
  runtime.lastError = null;
  runtime.needsRestart = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = null;
  appendLog(runtime, `starting pid=${child.pid ?? "unknown"}; awaiting exact Gateway READY`);
  managerOperationalLog.record("info", "gateway_started", {
    routeId: runtime.definition.id,
    childPid: child.pid,
    result: "started"
  });

  const stdoutLines = createGatewayOutputLineReader();
  child.stdout.on("data", (data) => {
    for (const line of stdoutLines(data)) {
      if (line.startsWith(GATEWAY_MESSAGE_HISTORY_PREFIX)) {
        const historyEvents = child.pid ? gatewayMessageHistoryEvents({
          line, expected: { gatewayId: runtime.definition.id, gatewayGenerationId: agentStateGeneration, pid: child.pid },
          currentChild: runtime.process === child && runtime.agentStateGeneration === agentStateGeneration,
          definition: runtime.definition, rootDir, routeDataDir: dataDirFor(runtime.definition), roleIdForDefinition, roleDirectory: roleDirForApi
        }) : [];
        for (const event of historyEvents) publishManagerEvent("message_endpoint_history_changed", event);
        // Stale or malformed private protocol frames are not user-facing Route logs.
        continue;
      }
      const ready = child.pid ? parseGatewayReadyLine(line, {
        gatewayId: runtime.definition.id,
        gatewayGenerationId: agentStateGeneration,
        pid: child.pid
      }) : null;
      if (ready && runtime.process === child) {
        runtime.readiness = "ready";
        runtime.endpoints = ready.endpoints;
        runtime.lastError = null;
        if (ready.routeSnapshotProtocol === 1 && ready.routeRevision === routeBoot.revision && child.pid) {
          gatewayRouteActivations.attach(child, { gatewayId: runtime.definition.id, gatewayGenerationId: agentStateGeneration, pid: child.pid }, routeBoot.definition, routeBoot.revision, ready.unavailableInstances);
        }
        releaseRouteBoot();
        appendLog(runtime, `READY generation=${agentStateGeneration} endpoints=${ready.endpoints.length}`);
        continue;
      }
      appendLog(runtime, line);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, `ERR ${line}`);
      runtime.lastError = line.slice(-2_000);
      if (/EADDRINUSE|address already in use/i.test(line) && runtime.readiness !== "ready") {
        runtime.readiness = "blocked";
      }
    }
  });

  child.on("exit", (code, signal) => {
    if (runtime.process !== child) return;
    runtime.process = null;
    runtime.agentStateGeneration = undefined;
    agentStateByGateway.delete(runtime.definition.id);
    runtime.stoppedAt = new Date().toISOString();
    if (runtime.readiness === "stopping" || (code === 0 && runtime.readiness === "ready")) {
      runtime.readiness = "stopped";
    } else if (runtime.readiness !== "blocked") {
      runtime.readiness = "failed";
    }
    runtime.endpoints = [];
    runtime.lastExit = {
      code,
      signal,
      at: runtime.stoppedAt
    };
    const backgroundFailures: unknown[] = [];
    try { appendLog(runtime, `exited code=${code ?? ""} signal=${signal ?? ""}`); }
    catch (error) { backgroundFailures.push(error); }
    try {
      managerOperationalLog.record(code === 0 ? "info" : "warn", "gateway_exited", {
        routeId: runtime.definition.id,
        childPid: child.pid,
        result: `code=${code ?? "null"}; signal=${signal ?? "null"}`
      });
    } catch (error) { backgroundFailures.push(error); }
    if (runtime.needsRestart && runtime.definition.enabled) {
      // Only this already-requested restart runs here; unrelated manual stops remain untouched.
      const startFailures = gatewayRuntimeService.startInBackground(runtime.definition.id);
      if (startFailures.length) {
        const original = startFailures[0];
        runtime.lastError = original instanceof Error ? original.message : String(original);
        if (!runtime.process) runtime.readiness = "failed";
        backgroundFailures.push(...startFailures);
      }
    }
    if (backgroundFailures.length) {
      const message = backgroundFailures.map(error => error instanceof Error ? error.message : String(error)).join("; ");
      runtime.lastError ??= message;
      // Last diagnostic sink: mutate the original memory buffer without invoking another fallible observer.
      runtime.log.push(`[${new Date().toISOString()}] Gateway background failure: ${message}`);
      if (runtime.log.length > 200) runtime.log.splice(0, runtime.log.length - 200);
    }
  });
}

function stopGatewayRuntime(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.process) {
    return;
  }

  appendLog(runtime, "stopping");
  runtime.readiness = "stopping";
  managerOperationalLog.record("info", "gateway_stop_requested", {
    routeId: runtime.definition.id,
    childPid: runtime.process.pid,
    result: "requested"
  });
  runtime.agentStateGeneration = undefined;
  agentStateByGateway.delete(runtime.definition.id);
  const child = runtime.process;
  gatewayRouteActivations.detach(child);
  gatewayListenerDetachers.get(child)?.();
  gatewayListenerDetachers.delete(child);
  void stopChildProcessTree(child).catch(() => { child.kill(); });
}

function startGateway(id: string): void {
  if (!gatewayRuntimePluginLease.active) throw new Error("Manager Gateway runtime plugin is inactive.");
  gatewayRuntimeService.start(id);
}

function stopGateway(id: string): void {
  if (!gatewayRuntimePluginLease.active) throw new Error("Manager Gateway runtime plugin is inactive.");
  gatewayRuntimeService.stop(id);
}

function restartGateway(id: string): void {
  if (!gatewayRuntimePluginLease.active) throw new Error("Manager Gateway runtime plugin is inactive.");
  gatewayRuntimeService.restart(id);
}

function stopAllGateways(): void {
  gatewayRuntimeService.stopAll();
}

function waitForGatewayChildExit(child: ChildProcessWithoutNullStreams, timeoutMs = getTimeoutMs("backend.manager.controlPlaneRoutes.waitForGatewayChildExit.timeoutMs", 5_000)): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => finish(Object.assign(new Error("Gateway child termination remains unconfirmed."), {
      code: "GATEWAY_TERMINATION_UNCONFIRMED"
    })), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopAllGatewaysAndWait(): Promise<void> {
  const children = runtimes.values()
    .map(runtime => runtime.process)
    .filter((child): child is ChildProcessWithoutNullStreams => Boolean(child));
  let stopFailure: unknown;
  try { stopAllGateways(); } catch (error) { stopFailure = error; }
  // A failed stop must not bypass joining other children whose shutdown was already requested.
  const joined = await Promise.allSettled(children.map(child => waitForGatewayChildExit(child)));
  const failures = joined.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (stopFailure) failures.unshift(stopFailure);
  if (failures.length) throw new AggregateError(failures, "Gateway shutdown was not fully confirmed.");
}

function dataDirFor(definition: GatewayDefinition): string {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  return routeFolderPath(managerRouteRoot(), configName);
}

function roleInfoFor(
  definition: GatewayDefinition,
  includeContents = true,
  _catalogCache?: Map<string, Array<Record<string, unknown>>>
): Record<string, unknown> {
  return roleInfoPayload(rootDir, definition, {
    includeContents,
    personaPresentations: routeCatalogPersonas()
  });
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
  const descriptor = currentAgentSessionDescriptors().get(adapterType);
  const fields = configuredLocalAgentSessionFields(definition, adapterType);
  return {
    agentAdapterType: adapterType,
    bound: false,
    ...(fields.sessionId ? { monitorThreadId: fields.sessionId } : {}),
    ...(fields.sessionName ? { monitorThreadName: fields.sessionName } : {}),
    ...(fields.workspace ? { monitorThreadCwd: fields.workspace, monitorProjectPath: fields.workspace } : {}),
    ...(descriptor ? {
      deliveryTransport: descriptor.manifest.transport.protocol,
      transportMode: descriptor.manifest.transport.mode,
      ...(descriptor.manifest.host ? { hostName: descriptor.manifest.host.name, hostRequired: descriptor.manifest.host.required } : {}),
      ...(descriptor.manifest.maturity === "stub" ? { handoffOnly: true } : {}),
      message: `${descriptor.manifest.label} 已配置；等待原执行端的投递状态。`
    } : { message: `Agent 插件不可用：${adapterType}。配置和原目标已保留。` })
  };
}

async function checkHttpEndpoint(url: string, timeoutMs = getTimeoutMs("agent.endpointProbe", 1200)): Promise<boolean> {
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

function routeCallbackEndpoint(runtime: GatewayRuntime, type: MessageAdapterType): MessageAdapterEndpoint | null {
  if (type !== "webhook" && type !== "xiaoai" && type !== "rabilink") return null;
  const definition = runtime.definition;
  const status = readGatewayStatus(definition) as Record<string, any>;
  const callback = status.httpCallbacks?.[type];
  const port = type === "xiaoai"
      ? definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
      : type === "rabilink"
        ? definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
        : definition.webhookPort ?? definition.gatewayPort;
  const pathValue = type === "xiaoai"
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

function routeHasRecentMessages(runtime: GatewayRuntime, type: MessageAdapterType): boolean | undefined {
  const service = activeGatewayDiagnosticsSnapshotService();
  service.requestRefresh();
  return service.hasRecentMessages(runtime.definition.id, type);
}



const NAPCAT_HEALTH_SCAN_DEADLINE_MS = 6_500;

function remoteAgentMessageAdapterScanResult(): PluginMessageAdapterScanResult {
  return remoteAgentHub?.localScanResult() ?? {
    type: "remoteAgent",
    label: "远端 Agent",
    maturity: "experimental",
    installed: false,
    requirements: [{
      id: "plugin",
      label: "Remote Agent 插件",
      required: true,
      ok: false,
      detail: "manager:remote-agent 未启用。"
    }],
    endpoints: [],
    warnings: ["启用 manager:remote-agent 后才会扫描和连接远端设备。"]
  };
}












let gatewayStatusSnapshotService: GatewayStatusSnapshotService | undefined;

function activeGatewayStatusSnapshotService(): GatewayStatusSnapshotService {
  gatewayStatusSnapshotService ??= new GatewayStatusSnapshotService({
    load: (statusPath, signal) => managerReadWorkerPool.run<Record<string, unknown>>({
      type: "gateway_status_snapshot", statusPath
    }, { signal, timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.load.managerReadWorkerPool.run.timeoutMs", 12_000) })
  });
  return gatewayStatusSnapshotService;
}

function readGatewayStatus(definition: GatewayDefinition): Record<string, unknown> {
  const statusPath = path.join(dataDirFor(definition), "gateway-status.json");
  if (process.env.RABIROUTE_MANAGER_READ_PROCESS === "1") return readGatewayStatusInWorker(statusPath);
  return activeGatewayStatusSnapshotService().read(definition.id, statusPath);
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
    if (!runtime.process || !sharedDefinitionUsesNapcat(runtime.definition)) {
      continue;
    }

    const configName = sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
    const configuredInstances = runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition);
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
  return localPersonaMessageDirectories(rootDir, definition, dataDirFor(definition));
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
    const child = spawnGatewayCommand(runtime, command);
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
    }, getTimeoutMs("deadline.manager.controlPlaneRoutes.deliverWearableAlertViaGateway", 10 * 60 * 1000));
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
  const service = activeGatewayDiagnosticsSnapshotService();
  service.requestRefresh();
  const snapshot = service.read(true);
  const cached = snapshot.records.find(record => record.id === runtime.definition.id);
  return memoryOnlyGatewayRuntimeStatus(rootDir, runtime, cached);
}

function runtimeStatusWithRoleInfoCache(
  runtime: GatewayRuntime,
  roleInfoCatalogCache?: Map<string, Array<Record<string, unknown>>>,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const usesNapcat = sharedDefinitionUsesNapcat(runtime.definition);
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
    personaAutomationScriptsEnabled: true,
    remoteAgentDefaultDeviceId: runtime.definition.remoteAgentDefaultDeviceId ?? "",
    remoteAgentDefaultCwd: runtime.definition.remoteAgentDefaultCwd ?? "",
    remoteAgentDefaultThreadName: runtime.definition.remoteAgentDefaultThreadName ?? "",
    napcatHttpUrl: runtime.definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
    napcatWebuiUrl: runtime.definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
    napcatAccessToken: runtime.definition.napcatAccessToken ?? "",
    napcatWebuiToken: runtime.definition.napcatWebuiToken ?? "",
    napcatInstances: usesNapcat ? (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)) : [],
    targetGroupId: runtime.definition.targetGroupId ?? "",
    routeVariables: runtime.definition.routeVariables,
    routeName: runtime.definition.routeName,
    routeProfiles: runtime.definition.routeProfiles ?? [],
    agentModel: runtime.definition.agentModel ?? "",
    agentReasoningEffort: runtime.definition.agentReasoningEffort,
    dshModelProvider: runtime.definition.dshModelProvider,
    dshModel: runtime.definition.dshModel,
    dshReasoningEffort: runtime.definition.dshReasoningEffort,
    codexThreadId: runtime.definition.codexThreadId,
    codexThreadName: resolveCodexThreadName(runtime.definition),
    codexCwd: runtime.definition.codexCwd,
    codexPlanAssistantEnabled: runtime.definition.codexPlanAssistantEnabled === true,
    codexPlanAssistantModel: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel),
    codexPlanAssistantSessions: runtime.definition.codexPlanAssistantSessions ?? [],
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
    grokBotProfilePath: runtime.definition.grokBotProfilePath,
    grokBotBackendUrl: runtime.definition.grokBotBackendUrl,
    grokBotAgentId: runtime.definition.grokBotAgentId,
    grokBotSessionId: runtime.definition.grokBotSessionId,
    grokBotSessionName: runtime.definition.grokBotSessionName,
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
    running: runtime.readiness === "ready",
    lifecycleState: runtime.readiness,
    endpoints: runtime.endpoints,
    lastError: runtime.lastError,
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

function runtimeSummaryStatusWithRoleInfoCache(
  runtime: GatewayRuntime,
  roleInfoCatalogCache?: Map<string, Array<Record<string, unknown>>>
): Record<string, unknown> {
  const definition = runtime.definition;
  const usesNapcat = sharedDefinitionUsesNapcat(definition);
  const napcatInstances = usesNapcat
    ? (definition.napcatInstances ?? sharedNormalizeNapCatInstances(definition)).map((instance) => ({
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
    running: runtime.readiness === "ready",
    lifecycleState: runtime.readiness,
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

/** Executed only inside ManagerReadWorkerPool's child process. */
export function buildGatewayDiagnosticsWorkerSnapshot(
  input: GatewayDiagnosticsWorkerInput
): GatewayDiagnosticsWorkerResult {
  return buildIsolatedGatewayDiagnosticsSnapshot(input, {
    reset: personaPresentations => {
      for (const id of runtimes.keys()) runtimes.delete(id);
      agentStateByGateway.clear();
      routeCatalogPersonaPresentations = Object.freeze([...personaPresentations]);
    },
    install: snapshot => {
      runtimes.set(snapshot.definition, {
        process: snapshot.processPid === null
          ? null
          : ({ pid: snapshot.processPid } as ChildProcessWithoutNullStreams),
        needsRestart: snapshot.needsRestart,
        startedAt: snapshot.startedAt,
        stoppedAt: snapshot.stoppedAt,
        lastExit: snapshot.lastExit,
        readiness: snapshot.readiness,
        endpoints: snapshot.endpoints,
        lastError: snapshot.lastError,
        log: [...snapshot.log]
      });
      agentStateByGateway.set(
        snapshot.definition.id,
        snapshot.agentStates as Partial<Record<AgentAdapterType, AgentRuntimeState>>
      );
    },
    runtimes: () => runtimes.values(),
    diagnostics: (runtime, roleInfoCatalogCache, tailCache) =>
      runtimeStatusWithRoleInfoCache(runtime, roleInfoCatalogCache, tailCache),
    summary: (runtime, roleInfoCatalogCache) =>
      runtimeSummaryStatusWithRoleInfoCache(runtime, roleInfoCatalogCache)
  });
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  try { managerRequestContexts.get(response)?.assertResponseAuthority?.(); }
  catch {
    statusCode = 403;
    body = { code: -1, error: "LAN_AGENT_AUTHORIZATION_REVOKED", uncertain: true };
    response.setHeader("cache-control", "no-store");
  }
  body = errorResponsePresentation(body, statusCode);
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
    () => preparedApiJson(body) ?? JSON.stringify(body)
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
        const body = text ? JSON.parse(text) : {};
        validateLanAgentRequestBody(request, body);
        resolve(body as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function singleRequestHeader(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new RoleStorageApplicationError(`${name} must be sent exactly once.`, "invalid_request", 400);
    }
    return value[0]?.trim() || undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function planHistoryRequestContext(
  request: http.IncomingMessage,
  body: Record<string, unknown>,
  context: RoleStorageCommandContext
): Promise<RoleStorageCommandContext> {
  const origin = singleRequestHeader(request, "origin");
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && new URL(origin).host === request.headers.host); } catch { /* Invalid Origin is not a user entry. */ }
  try {
    const actor = await resolvePlanHistoryRequestActor(request, body.messageSource, {
      verifiedUserEntry: sameOrigin && request.headers["sec-fetch-site"] === "same-origin",
      readThread: async query => {
        const options = agentThreadRequestOptions(query);
        const result = await handleAgentThreadRequest(query, options);
        const thread = result.data.thread as { id: string; title: string; cwd?: string; archived?: boolean } | undefined;
        if (result.statusCode !== 200 || !thread) throw new Error("Plan history messageSource owner could not be read.");
        return { ...thread, ...(query.agentAdapter === "dsh" && options.dshBaseUrl ? { baseUrl: options.dshBaseUrl } : {}) };
      }
    });
    return { ...context, actor };
  } catch (error) {
    throw new RoleStorageApplicationError(error instanceof Error ? error.message : String(error), "invalid_request", 400);
  }
}

/** Manager composition callbacks preserve the original history actor and feedback queue owners. */
export function createPersonaStorageOperationsContext(overrides: Partial<Pick<PersonaStorageOperationsContext, "roleDirectory" | "application" | "identity">> = {}): PersonaStorageOperationsContext {
  return {
    roleDirectory: roleDirForApi,
    application: currentRoleStorageApplication,
    identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
    readOnly: () => managerReadOnly,
    planHistoryContext: planHistoryRequestContext,
    scheduleFeedbackPostCommit: schedulePlanFeedbackPostCommit,
    reportFeedbackScheduleError: (roleId: string, planId: string, feedbackId: string, error: unknown) => {
      managerOperationalLog.record("warn", "plan_feedback_post_commit_schedule_failed", {
        action: roleId + ":" + planId + ":" + feedbackId, error: managerOperationalError(error, rootDir)
      });
    },
    publish: (type: "plan_status_catalog_changed" | "plan_feedback_changed" | "memory_consolidation_changed", data: Record<string, unknown>) => publishManagerEvent(type, data),
    rescheduleMemory: () => { memoryConsolidationScheduler?.reschedule(); },
    noteMemoryRunCompleted: (runId: string) => { memoryConsolidationScheduler?.noteRunCompleted(runId); },
    ...overrides
  };
}

function currentRoleStorageApplication(): RoleStorageApplication {
  if (!activeStorageLifecycleGeneration) {
    throw new RoleStorageApplicationError("Role storage is not ready.", "busy", 503);
  }
  return activeStorageLifecycleGeneration.roleStorage;
}

async function appendRolePanelTimeline(
  roleId: string,
  message: RolePanelTimelineMessage,
  application = currentRoleStorageApplication()
): Promise<RolePanelTimelineAppendResult> {
  const receipt = await application.commands.appendRolePanelTimeline(roleId, message, {
    idempotencyKey: roleStorageOperationKey("role-panel-timeline-append", roleId, message.id),
    expectedRevision: null
  });
  notifyRolePanelMessage(receipt.commit, publishManagerEvent);
  return receipt.commit;
}

async function submitAgentPlanFeedback(
  input: AgentPlanFeedbackSubmitRequest
): Promise<AgentPlanFeedbackSubmitResult> {
  const application = currentRoleStorageApplication();
  const projection = await application.queries.planFeedback(input.roleId, input.planId, {
    timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.submitAgentPlanFeedback.application.queries.planFeedback.timeoutMs", 30_000)
  });
  if (!projection) {
    throw new RoleStorageApplicationError(
      `Plan not found for feedback reply: ${input.roleId}/${input.planId}.`,
      "not_found",
      404
    );
  }
  const committed = await application.commands.submitPlanFeedback(input.roleId, input.planId, {
    feedbackId: input.feedbackId,
    stepId: input.stepId,
    gatewayId: input.gatewayId,
    kind: input.kind,
    author: "agent",
    source: "agent",
    text: input.text,
    notifyAgent: false
  }, {
    expectedRevision: projection.planRevision,
    idempotencyKey: roleStorageOperationKey("agent-plan-feedback-reply", input.deliveryId),
    timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.submitAgentPlanFeedback.application.commands.submitPlanFeedback.timeoutMs", 30_000)
  });
  return Object.freeze({
    record: committed.commit.record,
    created: committed.commit.created
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


type PlanFeedbackRequest = {
  formData?: unknown;
  reuseFeedbackId?: string;
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

function spawnGatewayCommand(
  runtime: GatewayRuntime,
  command: { command: string; args: readonly string[]; shell?: boolean | string },
  additionalEnvironment?: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
  return spawnGatewayCommandProcess({
    definition: runtime.definition,
    snapshotDirectory: path.join(dataDirFor(runtime.definition), ".rabi-runtime", "route-snapshots"),
    cwd: rootDir, ...command,
    environment: definition => ({ ...envFor(definition), ...additionalEnvironment }),
    cleanupError: error => {
      runtime.log.push(`[${new Date().toISOString()}] Command Route snapshot cleanup failed: ${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}`);
      if (runtime.log.length > 200) runtime.log.splice(0, runtime.log.length - 200);
    }
  });
}

function triggerGatewayManualRule(
  id: string,
  request: ManualTriggerRequest = {},
  completion: ManualTriggerCompletionCallbacks = {},
  owner?: string
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
      return spawnGatewayCommand(runtime, command);
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
    },
    owner
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
  return routeFolderPath(managerRouteRoot(), configName);
}

function listGatewayDeliveryReplayAttempts(id: string, limit: number, status: string | null): Record<string, unknown> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const dataDir = routeDataDirForDefinition(runtime.definition);
  const snapshot = listDeliveryReplayAttemptSnapshot(dataDir, {
    status: status === "failed" || status === "delivered" || status === "missed" || status === "routed" || status === "skipped" ? status : undefined,
    limit
  });
  return {
    gatewayId: id,
    dataDir: path.relative(rootDir, dataDir).replace(/\\/g, "/"),
    partial: snapshot.partial,
    diagnostics: snapshot.diagnostics,
    attempts: snapshot.attempts.map((attempt) => ({
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
    const child = spawnGatewayCommand(runtime, command);

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
  if (definition.agentRoleDeviceId) throw new Error("Remote persona storage belongs to the target PC.");
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleId = sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
  return roleFolderPath(rolesDir, roleId);
}

function memoryConsolidationScheduleTargets(): MemoryConsolidationScheduleTarget[] {
  return runtimes.values()
    .filter((runtime) => runtime.definition.enabled !== false && !runtime.definition.agentRoleDeviceId)
    .map((runtime) => {
      const roleDir = roleDirForDefinition(runtime.definition);
      const roleId = roleIdForDefinition(runtime.definition);
      return {
        gatewayId: runtime.definition.id,
        roleId,
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
        void currentRoleStorageApplication().commands.markMemoryConsolidationDelivered(
          target.roleId,
          run.runId,
          undefined,
          {
            idempotencyKey: roleStorageOperationKey("memory-delivered", run.runId),
            expectedRevision: run.revision,
            timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.onSuccess.currentRoleStorageApplication__.commands.markMemoryConsolidationDelivered.timeoutMs", 30_000)
          }
        ).then(() => {
          const runtime = runtimes.get(target.gatewayId);
          publishManagerEvent("memory_consolidation_changed", {
            gatewayId: target.gatewayId,
            roleId: runtime ? roleIdForDefinition(runtime.definition) : target.roleId,
            runId: run.runId,
            status: "requested"
          });
          resolve();
        }, reject);
      },
      onFailure: reject
    }, "manager:memory-consolidation");
    if (result.alreadyRunning) resolve();
  });
}

function roleIdForDefinition(definition: GatewayDefinition): string {
  return sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
}

function roleIdsForPlanBoundSession(sessionId: string, cwd?: string, source?: PlanBindingSource): Set<string> {
  const roleIds = new Set<string>();
  const candidateRoleIds = new Set(
    [...runtimes.values()].filter(runtime => !runtime.definition.agentRoleDeviceId).map(runtime => roleIdForDefinition(runtime.definition))
  );
  for (const roleId of candidateRoleIds) {
    const roleDir = roleDirForApi(roleId);
    const plans = publishedRolePlans(roleDir);
    if (!plans) {
      requestRoleKnowledgeCatalogRefresh(roleDir);
      continue;
    }
    for (const plan of plans) {
      const bindings = [plan.taskBinding, plan.secretaryBinding];
      if (bindings.some((binding) => (source ? planBindingMatchesSource(binding, source)
        : binding?.sessionId === sessionId && !("instanceBinding" in binding && binding.instanceBinding)) && hookWorkspaceMatches(binding?.workspace, cwd))) {
        roleIds.add(roleId);
        break;
      }
    }
  }
  return roleIds;
}

/** Ownership checks must not consult local persona plans before rejecting a remote Route. */
function gatewayIdsForConfiguredSession(sessionId: string, cwd?: string, source?: PlanBindingSource): Set<string> {
  const exactSessionId = String(sessionId || "").trim();
  const gatewayIds = new Set<string>();
  if (source?.sourceInstance) return gatewayIds;
  for (const runtime of runtimes.values()) {
    if (
      (String(runtime.definition.codexThreadId || "").trim() === exactSessionId
        && hookWorkspaceMatches(runtime.definition.codexCwd, cwd))
      || (String(runtime.definition.dshSessionId || "").trim() === exactSessionId
        && hookWorkspaceMatches(runtime.definition.dshCwd, cwd))
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
  return gatewayIds;
}

function configuredPersonaDefinitionsForSession(sessionId: string, cwd?: string): GatewayDefinition[] {
  return [...gatewayIdsForConfiguredSession(sessionId, cwd)]
    .map(id => runtimes.get(id)?.definition)
    .filter((definition): definition is GatewayDefinition => Boolean(definition));
}

function gatewayIdsForManagedSession(sessionId: string, cwd?: string, source?: PlanBindingSource): Set<string> {
  const exactSessionId = String(sessionId || "").trim();
  const gatewayIds = gatewayIdsForConfiguredSession(exactSessionId, cwd, source);
  const roleIds = roleIdsForPlanBoundSession(exactSessionId, cwd, source);
  if (roleIds.size > 0) {
    for (const runtime of runtimes.values()) {
      if (routeOwnsLocalPersona(runtime.definition) && roleIds.has(roleIdForDefinition(runtime.definition))) gatewayIds.add(runtime.definition.id);
    }
  }
  return gatewayIds;
}

function codexHookSettingsForSession(sessionId: string, cwd?: string, agentType = "codex", sourceInstance?: PlanBindingSource["sourceInstance"]): CodexHookSettings {
  const exactSessionId = String(sessionId || "").trim();
  const managedGatewayIds = gatewayIdsForManagedSession(exactSessionId, cwd, { sessionId, agentType, sourceInstance });
  const matches = [...runtimes.values()].filter((runtime) => (
    managedGatewayIds.has(runtime.definition.id)
  ));
  if (matches.length === 0) return { ...DEFAULT_CODEX_HOOK_SETTINGS };
  const settings = matches.map((runtime) => agentHookSettingsFor(runtime.definition.codexHooks, agentType));
  return {
    sessionContextEnabled: settings.every((item) => item.sessionContextEnabled),
    reasoningContextEnabled: settings.every((item) => item.reasoningContextEnabled),
    planTaskCompletionEnabled: settings.every((item) => item.planTaskCompletionEnabled),
    onlyPrimaryPersonaCanSendMessages: false
  };
}

function codexHookEnabled(request: CodexHookContextRequest): boolean {
  const settings = codexHookSettingsForSession(request.sessionId, request.cwd, request.agentType, request.sourceInstance);
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

function hookRequestMatchesParty(request: CodexHookContextRequest, party: AgentRequestParty): boolean {
  const endpoint = party.endpoint;
  if (endpoint && endpoint.kind !== "local" && endpoint.kind !== "instance") return false;
  return planBindingMatchesSource({ agentType: party.agentAdapter || "codex", sessionId: party.threadId,
    ...(endpoint?.kind === "instance" ? { instanceBinding: { instanceId: endpoint.instanceId!, agentId: endpoint.agentId, ...(endpoint.ownerDeviceId ? { ownerDeviceId: endpoint.ownerDeviceId } : {}) } } : {}) }, request);
}

async function recordAgentRequestStop(request: CodexHookContextRequest): Promise<AgentRequestStopResult> {
  if (managerReadOnly) return { status: "ignored", reason: "manager_read_only", turnId: request.turnId };
  const turnId = String(request.turnId || "").trim();
  if (!turnId) return { status: "ignored", reason: "missing_turn_id" };
  await agentRequests.ready();
  const matches = (party: AgentRequestParty) => hookRequestMatchesParty(request, party);
  const sessionSnapshot = agentRequests.unansweredTargetRequestSnapshot(request.sessionId, undefined, matches);
  const pendingSessionRequestIds = sessionSnapshot.requestIds;
  const requestIds = request.cwd ? agentRequests.unansweredTargetRequestSnapshot(request.sessionId, request.cwd, matches).requestIds : pendingSessionRequestIds;
  return { status: requestIds.length ? "pending" : "ignored", reason: requestIds.length
    ? "unanswered_agent_requests_at_stop" : "no_unanswered_agent_requests", requestIds, pendingSessionRequestIds, snapshotComplete: sessionSnapshot.complete, turnId };
}

function agentThreadAllowedWorkspaces(): string[] {
  // Public Agent APIs are available to authenticated callers across workspaces.
  // Cwd and query remain caller-selected context or filters, not Route grants.
  return [];
}

const speechModelManager = createPluginServicePort(() => currentSpeechService().speechModelManager);

function applyManagedAgentThreadDefaults(request: AgentThreadRequest): AgentThreadRequest {
  if (request.action !== "send") return request;
  if (request.model?.trim()) return request;
  const targetRuntime = request.threadId ? runtimeForAgentThreadRequest(request) : undefined;
  const roleId = targetRuntime && !targetRuntime.definition.agentRoleDeviceId ? roleIdForDefinition(targetRuntime.definition) : "";
  const plans = roleId ? publishedRolePlans(roleDirForApi(roleId)) : undefined;
  const bindingModel = plans?.find(plan => planBindingTargetKey(plan.taskBinding ?? {}) === planBindingTargetKey({ agentType: request.agentAdapter, sessionId: request.threadId, instanceBinding: request.instanceBinding }))?.taskBinding?.modelSnapshot?.trim();
  if (bindingModel) return { ...request, model: bindingModel };
  const model = resolveCodexPlanAssistantTurnModel(
    [...runtimes.values()].flatMap((runtime) => !runtime.definition.agentRoleDeviceId && runtime.definition.codexPlanAssistantEnabled === true
      ? (runtime.definition.codexPlanAssistantSessions ?? []).map((session) => ({ ...session, model: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel) }))
      : []), request.threadId, request.model, request.instanceBinding ? remoteAgentTargetKey(request.instanceBinding) : `local:${request.agentAdapter || "codex"}`
  );
  return model ? { ...request, model } : request;
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

async function maintainAgentSendReceipt(
  deliveryId: string,
  request: AgentSendRequest,
  options: { requestAuthority?: () => void },
  settle: boolean
): Promise<AgentCommunicationHttpResponse> {
  const replyOptions = () => ({
    endpointEgress: (capability: string) => resolvePublishedPluginService(capability) as import("@rabiroute/plugin-sdk").MessageEndpointEgressProvider | undefined,
    rootDir, routeRoot: managerRouteRoot(), rolesRoot: managerRolesRoot(),
    runtimes: [...runtimes.values()].map(runtime => ({
      ...runtime.definition,
      napcatInstances: (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition))
        .map(instance => ({ ...instance, accessToken: instance.accessToken ?? "" }))
    }))
  });
  const verify = createAgentSendVerificationEvidenceVerifier({
    inspect: async (originalRequest, requestDigest) => {
      const prepared = prepareAgentSendRequest(originalRequest);
      const source = agentReplyHistorySource(prepared.internal, replyOptions());
      return inspectOriginalAgentSendHistory(originalRequest, requestDigest, {
        ...source, mapResult: mapAgentSendReplyResult
      });
    },
    verifyCurrentPresence: original => verifyQqFileCurrentPresence(original, {
      endpointEgress: capability => resolvePublishedPluginService(capability) as import("@rabiroute/plugin-sdk").MessageEndpointEgressProvider | undefined,
      readCurrentBinding: expected => {
        options.requestAuthority?.();
        const current = agentReplyCurrentQqBinding({ routeProfileId: expected.routeId,
          groupId: expected.groupId, instanceId: expected.instanceId }, replyOptions());
        return current ? { ...current, selfId: expected.selfId, readAllowed: true } : undefined;
      },
      readAccountIdentity: async (current, signal) => {
        signal.throwIfAborted();
        options.requestAuthority?.();
        const provider = resolvePublishedPluginService("endpoint.napcat.egress@1") as import("@rabiroute/plugin-sdk").MessageEndpointEgressProvider | undefined;
        if (!provider) throw new Error("NapCat endpoint plugin is unavailable.");
        const lease = provider.acquire({ ...current, endpoint: { ...current.endpoint } });
        let login: { userId?: string | number };
        try { login = await lease.call("getLoginInfo", [current.endpoint, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.readAccountIdentity.getLoginInfo.timeoutMs", 2_000) }]); }
        finally { lease.release(); }
        signal.throwIfAborted();
        options.requestAuthority?.();
        return login.userId === undefined ? undefined : { selfId: String(login.userId) };
      }
    })
  });
  const reconcile = settle ? settleAgentSendDelivery : verifyAgentSendDelivery;
  return reconcile(deliveryId, request, { rootDir, verify, requestAuthority: options.requestAuthority });
}

async function readAgentChatHistory(requestUrl: URL) {
        const { send, query } = parseAgentChatHistoryQuery(requestUrl);
        const readOptions = { rootDir, routeRoot: managerRouteRoot(), rolesRoot: managerRolesRoot(), runtimes: [...runtimes.values()].map(runtime => ({ ...runtime.definition,
          napcatInstances: (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition))
            .map(instance => ({ ...instance, accessToken: instance.accessToken ?? "" })) })) };
        const history = await conversationContextGuard.searchHistory(send, readOptions, query);
        return projectAgentChatHistory(history);
}

async function performAgentSend(
  request: AgentSendRequest,
  options: { remoteSource?: TrustedLanAgentSource; requestAuthority?: () => void; withManagedGroupFile?: import("../outbox.js").AgentReplyOptions["withManagedGroupFile"] } = {}
): Promise<AgentCommunicationHttpResponse> {
  const snapshot = { rootDir, routeRoot: managerRouteRoot(), rolesRoot: managerRolesRoot(),
    runtimes: [...runtimes.values()].map(runtime => ({ ...runtime.definition,
      napcatInstances: (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition))
        .map(instance => ({ ...instance, accessToken: instance.accessToken ?? "" })) })) };
  return conversationSendQueue.run(conversationContextGuard.serializationKey(request, snapshot), () => performConversationAgentSend(request, options));
}

async function performConversationAgentSend(
  request: AgentSendRequest,
  options: { remoteSource?: TrustedLanAgentSource; requestAuthority?: () => void; withManagedGroupFile?: import("../outbox.js").AgentReplyOptions["withManagedGroupFile"] } = {}
): Promise<AgentCommunicationHttpResponse> {
  // Conversation review precedes optional content review and all new send reservations.
  // Durable receipts bypass it: retries inspect/reconcile the original delivery rather than resend.
  const initialPrepared = prepareAgentSendRequest(request);
  const conversationOptions = { rootDir, routeRoot: managerRouteRoot(), rolesRoot: managerRolesRoot(),
    runtimes: [...runtimes.values()].map(runtime => ({ ...runtime.definition,
      napcatInstances: (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition))
        .map(instance => ({ ...instance, accessToken: instance.accessToken ?? "" })) })) };
  let reviewedIndex: string | undefined;
  let reviewedConversationContext: AgentSendResult["conversationContext"];
  const conversationRejection = async () => {
    options.requestAuthority?.();
    const decision = await conversationContextGuard.evaluate(request, conversationOptions);
    options.requestAuthority?.();
    if (!decision.blocked) {
      reviewedConversationContext = decision.context;
      reviewedIndex = decision.context?.latestMessageIndex; return undefined;
    }
    return { statusCode: 409, body: { ok: false, status: "conversation_context_confirmation_required",
      errorCode: "AGENT_SEND_CONVERSATION_CONTEXT_CONFIRMATION_REQUIRED",
      reason: decision.context!.instruction, deliveryId: initialPrepared.deliveryId,
      sender: initialPrepared.sender, channel: initialPrepared.channel, routeId: initialPrepared.routeId,
      target: initialPrepared.target, conversationContext: decision.context } };
  };
  if (!readAgentSendReceipt(rootDir, initialPrepared.deliveryId)) {
    const rejection = await conversationRejection();
    if (rejection) return rejection;
  }
  const gate = await resolveReviewedAgentSendGate(request, {
    readReceipt: deliveryId => readAgentSendReceipt(rootDir, deliveryId),
    authorize: snapshot => { prepareAgentSendRequest(snapshot); },
    validate: snapshot => messageProcessingSendContextReview.validateSend(snapshot)
  });
  request = gate.request;
  const receiptBeforeValidation = gate.receipt;
  const prepared = prepareAgentSendRequest(request);
  const validatedSendContext = gate.context;
  let reviewedReplySource: ReviewedReplySourceEvidence | undefined;
  if (validatedSendContext?.sourceMessageId
    && prepared.channel === "napcat"
    && prepared.target.target === "group") {
    const roleId = String(validatedSendContext.requirement.source.roleId || "").trim();
    if (!roleId) {
      throw new Error(`Cannot recover reviewed source ${validatedSendContext.sourceMessageId}: requirement has no roleId.`);
    }
    const recovered = validatedSendContext.reviewedSource;
    if (!recovered) throw new Error("The bounded reader did not return the reviewed source evidence.");
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

  const replyOptions = {
    endpointEgress: (capability: string) => resolvePublishedPluginService(capability) as import("@rabiroute/plugin-sdk").MessageEndpointEgressProvider | undefined,
    rootDir,
    routeRoot: managerRouteRoot(),
    rolesRoot: managerRolesRoot(),
    withManagedGroupFile: options.withManagedGroupFile,
    withManagedPlanAttachment: resolveSendManagedPlanAttachment,
    speechServiceUrl: speechServiceUrl(),
    publishEvent: publishManagerEvent,
    appendRolePanelTimeline,
    submitPlanFeedback: submitAgentPlanFeedback,
    remoteLanguageStyle: async () => {
      const runtime = runtimeForAgentSendRoute(prepared.routeId);
      if (!runtime) throw new Error("Remote persona Route is no longer available.");
      const profile = runtime.definition.routeProfiles?.find(item => item.id === prepared.routeId);
      const selection = profile ? { ...runtime.definition, ...profile } : runtime.definition;
      const context = remotePersonaReadContext();
      const snapshot = await resolveRemotePersonaSnapshot(selection, context);
      const binding = snapshot.personaConfig.languageStyle;
      if (!binding) return { blocked: false };
      if (prepared.styleValidation === 0) return { blocked: false, metadata: { mode: 0 as const, bypassed: true, styleSkillUrl: binding.styleSkillUrl } };
      const text = typeof prepared.internal.text === "string" ? prepared.internal.text.trim() : "";
      if (!text) return { blocked: false };
      const result = await validateRemotePersonaLanguageStyle(snapshot, text, context);
      return { blocked: !result.passed, metadata: { mode: 1 as const, bypassed: false, styleSkillUrl: binding.styleSkillUrl, result } };
    },
    runtimes: [...runtimes.values()].map(runtime => {
      const relay = rabiLinkRelayConfigFor(runtime.definition);
      return {
        ...runtime.definition,
        rabiLinkRelay: relay,
        napcatInstances: (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)).map(instance => ({
          ...instance,
          accessToken: instance.accessToken ?? ""
        }))
      };
    })
  };
  if (!receiptBeforeValidation) {
    validateAgentSendReplyImageDescriptions(request, replyOptions, reviewedReplySource);
  }

  const existingReceipt = readAgentSendReceipt(rootDir, String(request.deliveryId || ""));
  let languageStyleValidation: AgentSendResult["languageStyleValidation"];
  let messageLengthValidation: AgentSendResult["messageLengthValidation"];
  if (!existingReceipt) {
    const lengthDecision = messageLengthGuard.evaluate(request, replyOptions);
    messageLengthValidation = lengthDecision.metadata;
    const styleDecision = await evaluateAgentSendLanguageStyle(request, replyOptions, languageStyleValidator);
    languageStyleValidation = styleDecision.metadata;
    if (lengthDecision.blocked) {
      return {
        statusCode: 409,
        body: {
          ok: false, status: "message_length_confirmation_required",
          errorCode: "AGENT_SEND_MESSAGE_LENGTH_CONFIRMATION_REQUIRED",
          reason: `消息正文共 ${messageLengthValidation!.characterCount} 字，超过 ${messageLengthValidation!.threshold} 字。先精简；一条说不清时，按完整意思拆成少量消息，一句接一句说，每条分别检查并使用独立稳定 deliveryId。确需保留单条原文时，以同一 deliveryId 和完整原请求再次调用，附带 messageLengthConfirmation。`,
          deliveryId: prepared.deliveryId, sender: prepared.sender, channel: prepared.channel,
          routeId: prepared.routeId, target: prepared.target, messageLengthValidation,
          ...(reviewedConversationContext ? { conversationContext: reviewedConversationContext } : {}),
          ...(languageStyleValidation ? { languageStyleValidation } : {})
        }
      };
    }
    if (styleDecision.blocked) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          status: "style_confirmation_required",
          reason: "Language style validation failed. Review the reasons, then resend the same deliveryId with styleValidation=0 only after confirming the text is intentional.",
          deliveryId: prepared.deliveryId,
          sender: prepared.sender,
          channel: prepared.channel,
          routeId: prepared.routeId,
          target: prepared.target,
          languageStyleValidation,
          ...(reviewedConversationContext ? { conversationContext: reviewedConversationContext } : {}),
          ...(messageLengthValidation ? { messageLengthValidation } : {})
        }
      };
    }
  }

  if (!existingReceipt) {
    // The style/source validators above may await external work; read the ledger again afterwards.
    const rejection = await conversationRejection();
    if (rejection) return rejection;
  }
  const deliver = async () => {
    options.requestAuthority?.();
    assertReviewedAgentSendMayDeliver(gate);
    return {
      ...await handleAgentSend(request, replyOptions, reviewedReplySource),
      ...(messageLengthValidation ? { messageLengthValidation } : {}),
      ...(languageStyleValidation ? { languageStyleValidation } : {})
    };
  };
  const result = await executeIdempotentAgentSend(request, {
    rootDir,
    requestAuthority: options.requestAuthority,
    deliver,
    recover: gate.replayOnly ? undefined : async () => {
      const inspection = await inspectAgentSendDelivery(request, replyOptions);
      if (inspection.state === "completed") return inspection;
      if (inspection.state === "missing") return { state: "retry" };
      return { state: "uncertain", reason: inspection.reason };
    }
  });
  if (result.body.replyImageDescriptionArchive && result.body.idempotency.duplicate === false) {
    managerOperationalLog.record("info", "agent_reply_image_descriptions_archived", {
      action: String(request.deliveryId || ""),
      result: `sourceMessageId=${result.body.replyImageDescriptionArchive.sourceMessageId}; files=${result.body.replyImageDescriptionArchive.files.length}`
    });
  }
  recordMessageProcessingSend(request, result.body);
  // Even cached/recovered receipts report the current read index without sending a duplicate.
  let latest: AgentSendResult["conversationContext"];
  try {
    latest = (await conversationContextGuard.evaluate({ ...request, conversationContext: reviewedIndex ? { lastReadMessageIndex: reviewedIndex } : undefined }, replyOptions, Date.now(), true)).context;
  } catch (error) {
    // A post-send history error must not hide an already committed delivery receipt.
    result.body.conversationContextError = error instanceof Error ? error.message : String(error);
  }
  if (latest) result.body.conversationContext = { ...latest, confirmationRequired: false,
    confirmationToken: undefined, expiresAt: undefined,
    instruction: latest.messages.length ? "本次发送结果以回执为准；以下是发送期间新增的消息，下次发送前仍需核对。" : undefined };
  if (latest && reviewedIndex) {
    const onlyOwnReply = latest.messages.every(item => item.direction === "outbound"
      && item.messageId !== undefined && String(item.messageId) === String(result.body.sentMessageId));
    // Do not silently mark messages arriving during network delivery as read.
    conversationContextGuard.rememberReturnedIndex(request, replyOptions, onlyOwnReply ? latest.latestMessageIndex : reviewedIndex);
  }
  return result;
}


async function dispatchPlanNotificationRequirement(requirement: MessageProcessingRequirement): Promise<void> {
  if (requirement.kind !== "plan_progress_notification") return;
  const target = currentMessageProcessingTarget(requirement);
  const worker = target?.worker;
  if (!target || !worker?.threadId || !worker.workspace) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, "当前 Route 没有可用的主角色或消息处理 Agent 任务；等待配置恢复或人工重新分配。");
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
    return;
  }
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, "当前 Route 运行实例不可用，未投递计划进展通知。");
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
    return;
  }
  const messageSource = planMessageSource(
    requirement.plan?.planId,
    requirement.plan?.planTitle
  );
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
      agentAdapter: worker.agentAdapter ?? (isDshSessionId(worker.threadId) ? "dsh" : "codex"),
      threadId: worker.threadId,
      title: worker.threadName,
      createIfMissing: true,
      cwd: worker.workspace,
      sandbox: "workspace-write",
      messageSource,
      prompt
    }, {
      allowedWorkspaces: agentThreadAllowedWorkspaces(),
      defaultWorkspace: rootDir,
      dshBaseUrl: runtime.definition.dshBaseUrl
    });
    if (result.data.status !== "delivered") {
      throw new Error(String(result.data.warning || result.data.message || "Plan notification was not accepted."));
    }
    const resolved = await persistResolvedMessageProcessingTarget(
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
  const managedAdapter = primaryMessageProcessingAgentAdapter(runtime.definition);
  const maxAgents = managedAdapter ? runtime.definition.messageProcessingAgents?.[managedAdapter]?.maxAgents : undefined;
  const messageAgentModeEnabled = Boolean(managedAdapter);
  const managedWorker = messageAgentModeEnabled
    ? resolveCurrentMessageAgentWorker(
      messageAgentPoolStatePath(messageWorkerDataDir(runtime.definition)),
      requirement.worker,
      maxAgents,
      {
        groupId: requirement.messageGroupId || requirement.id,
        endpoint: requirement.source.endpoint,
        conversationKey: requirement.source.conversationKey,
        sender: requirement.source.sender
      },
      {},
      primaryAgentWorkspace(runtime.definition)
    )
    : undefined;
  return resolveMessageProcessingDeliveryTarget(effectiveInstanceDefinition(runtime.definition), managedWorker);
}

function runtimeForMessageProcessingTarget(target: MessageProcessingDeliveryTarget): GatewayRuntime | undefined {
  if (target.agentType === "primary_persona") {
    return [...runtimes.values()].find((runtime) =>
      primaryAgentSessionId(runtime.definition) === target.worker.threadId
        && primaryAgentWorkspace(runtime.definition) === target.worker.workspace
    );
  }
  return [...runtimes.values()].find((runtime) => {
    const adapter = primaryMessageProcessingAgentAdapter(runtime.definition);
    return readCurrentMessageAgentWorkers(
      messageAgentPoolStatePath(messageWorkerDataDir(runtime.definition)),
      adapter ? runtime.definition.messageProcessingAgents?.[adapter]?.maxAgents : undefined,
      primaryAgentWorkspace(runtime.definition)
    ).some((worker) => worker.threadId === target.worker.threadId && worker.agentAdapter === target.worker.agentAdapter);
  });
}

async function replaceOpenAgentRequestParties(
  previousThreadId: string,
  previousWorkspace: string | undefined,
  worker: NonNullable<MessageProcessingRequirement["worker"]>
): Promise<void> {
  const result = await agentRequests.reconcileOpenParties((party) => party.threadId === previousThreadId
    && (!previousWorkspace || !party.workspace || sameCodexWorkspace(party.workspace, previousWorkspace))
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

async function persistResolvedMessageProcessingTarget(
  target: MessageProcessingDeliveryTarget,
  result: Record<string, unknown>,
  runtime: GatewayRuntime | undefined
): Promise<MessageProcessingDeliveryTarget> {
  const resolved = resolveDeliveredMessageProcessingTarget(target, result);
  if (!resolved.previousThreadId) return resolved.target;
  if (!runtime) {
    throw new Error(`Cannot persist replacement for archived ${target.agentType} task ${resolved.previousThreadId}.`);
  }
  const replacement = resolved.target.worker;
  const primaryWorkspace = primaryAgentWorkspace(runtime.definition);
  if (!sameCodexWorkspace(replacement.workspace, primaryWorkspace)) {
    throw new Error(`Archived ${target.agentType} task replacement returned a workspace different from the Primary Persona.`);
  }
  if (target.agentType === "primary_persona") {
    const primaryAdapter = target.worker.agentAdapter ?? (target.worker.threadId.startsWith("session-") ? "dsh" : "codex");
    const configuredThreadId = String(primaryAgentSessionId(runtime.definition) || "").trim();
    if (configuredThreadId !== resolved.previousThreadId && configuredThreadId !== replacement.threadId) {
      throw new Error(`Primary Persona binding changed before archived task replacement could be saved: ${configuredThreadId}`);
    }
    if (configuredThreadId !== replacement.threadId) {
      if (primaryAdapter === "dsh") {
        runtime.definition.dshSessionId = replacement.threadId;
        runtime.definition.dshSessionName = replacement.threadName;
        runtime.definition.dshCwd = replacement.workspace;
      } else {
        runtime.definition.codexThreadId = replacement.threadId;
        runtime.definition.codexThreadName = replacement.threadName;
        runtime.definition.codexCwd = replacement.workspace;
      }
      await writeAdapterConfigFile(runtime.definition);
    }
  } else {
    const statePath = messageAgentPoolStatePath(messageWorkerDataDir(runtime.definition));
    const replaced = replacePersistedMessageAgentWorker(
      statePath,
      resolved.previousThreadId,
      replacement
    );
    const alreadyPersisted = !replaced && readCurrentMessageAgentWorkers(
      statePath,
      primaryMessageProcessingAgentAdapter(runtime.definition)
        ? runtime.definition.messageProcessingAgents?.[primaryMessageProcessingAgentAdapter(runtime.definition)!]?.maxAgents
        : undefined,
      primaryAgentWorkspace(runtime.definition)
    ).some((worker) => worker.threadId === replacement.threadId);
    if (!replaced && !alreadyPersisted) {
      throw new Error(`Message Agent replacement could not be saved: ${resolved.previousThreadId}`);
    }
  }
  messageProcessingBoard.replaceWorkerReferences(resolved.previousThreadId, replacement);
  await replaceOpenAgentRequestParties(resolved.previousThreadId, target.worker.workspace, replacement);
  await reconcileMessageProcessingAgentRequests();
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
    const managedAdapter = primaryMessageProcessingAgentAdapter(runtime.definition);
    const modeEnabled = Boolean(managedAdapter);
    const workers = readCurrentMessageAgentWorkers(
      messageAgentPoolStatePath(messageWorkerDataDir(runtime.definition)),
      managedAdapter ? runtime.definition.messageProcessingAgents?.[managedAdapter]?.maxAgents : undefined,
      primaryAgentWorkspace(runtime.definition)
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

async function reconcileMessageProcessingAgentRequests(): Promise<void> {
  const knownMessageWorkers = new Set(messageProcessingBoard.snapshot().requirements
    .flatMap((requirement) => requirement.worker?.threadId ? [requirement.worker.threadId] : []));
  const result = await agentRequests.reconcileOpenParties((party, record) => {
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
  const service = knowledgeCallbackReminderService;
  if (!service) return;
  void service.schedule(requirement).catch(error => {
    managerOperationalLog.record("warn", "knowledge_callback_reminder_schedule_failed", {
      action: requirement.id,
      error: managerOperationalError(error, rootDir)
    });
  });
}

async function deliverKnowledgeCallbackReminder(requirement: MessageProcessingRequirement): Promise<void> {
  const pending = messageProcessingBoard.pendingKnowledgeMatches(requirement.id);
  if (!pending.length) return;
  const target = currentMessageProcessingTarget(requirement);
  const worker = target?.worker;
  if (!target || !worker?.threadId || !worker.workspace) {
    throw new Error("Knowledge callback reminder has no active Agent target.");
  }
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    throw new Error("Knowledge callback reminder has no active Route runtime.");
  }
  const messageSource: RabiMessageSource = {
    type: "system",
    eventType: "knowledge_callback_reminder",
    eventName: "知识回调提醒",
    eventId: requirement.id,
    routeName: runtime.definition.name,
    routeId: runtime.definition.id
  };
  const prompt = buildKnowledgeCallbackReminderPrompt(requirement, pending);
  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: worker.agentAdapter ?? (isDshSessionId(worker.threadId) ? "dsh" : "codex"),
    threadId: worker.threadId,
    title: worker.threadName,
    createIfMissing: true,
    cwd: worker.workspace,
    prompt,
    sandbox: "workspace-write",
    messageSource
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl
  });
  if (result.data.status !== "delivered") {
    throw new Error(String(result.data.warning || result.data.message || "Knowledge callback reminder was not accepted."));
  }
  const resolved = await persistResolvedMessageProcessingTarget(
    target,
    result.data,
    runtime
  );
  messageProcessingBoard.recordWorkerReference(requirement.id, resolved.worker);
  const warning = typeof result.data.warning === "string" ? result.data.warning.trim() : "";
  if (warning) {
    managerOperationalLog.record("warn", "knowledge_callback_reminder_target_replaced", {
      action: `${requirement.id}:${worker.threadId}->${resolved.worker.threadId}`,
      result: warning
    });
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
  const routeId = String(item.source.routeProfileId || item.source.routeId || "").trim();
  const runtime = runtimeForAgentSendRoute(routeId);
  const profile = runtime?.definition.routeProfiles?.find(candidate => candidate.id === routeId);
  if (!runtime || (profile?.agentRoleDeviceId ?? runtime.definition.agentRoleDeviceId)) return;
  const roleId = String(roleIdInput || item.source.roleId || "").trim();
  const planId = String(planIdInput || item.plan?.planId || "").trim();
  if (!roleId || !planId) return;
  try {
    const roleDir = roleDirForApi(roleId);
    const plan = getPublishedPlan(roleDir, planId);
    if (plan) messageProcessingBoard.setPlanBaseline(roleId, plan);
    else requestRoleKnowledgeCatalogRefresh(roleDir);
  } catch {
    // The linked requirement remains visible; the next plan update can establish the baseline.
  }
}

async function handleMessageProcessingPlanUpdate(roleDir: string, plan: PlanItem | null): Promise<void> {
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

async function recordUserFeedbackChat(roleId: string, feedback: PlanFeedbackRecord, result: { statusCode: number; data: Record<string, unknown> }): Promise<void> {
  try {
    await recordPersonaUserDelivery(roleDirForApi(roleId), feedback, result,
      () => publishManagerEvent("persona_chat_history_changed", { roleId }));
  } catch (error) {
    managerOperationalLog.record("warn", "user_feedback_chat_history_failed", {
      action: feedback.id, error: managerOperationalError(error, rootDir)
    });
  }
}

async function sendPlanFeedbackToTask(
  roleId: string,
  planId: string,
  dshBaseUrl: string | undefined,
  request: PlanQaTaskRequest | PlanApprovalFeedbackTaskRequest,
  deliveryId = "deliveryId" in request ? request.deliveryId : undefined,
  userFeedback?: PlanFeedbackRecord
): Promise<void> {
  const projection = await currentRoleStorageApplication().queries.plan(roleId, planId, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.sendPlanFeedbackToTask.currentRoleStorageApplication__.queries.plan.timeoutMs", 30_000) });
  const plan = projection?.plan;
  if (!plan) {
    throw new Error(`Role plan catalog is unavailable or plan was not found: ${planId}`);
  }
  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: request.agentAdapter,
    ...(request.instanceBinding ? { instanceBinding: request.instanceBinding } : {}),
    threadId: request.threadId,
    title: request.title,
    createIfMissing: request.createIfMissing,
    cwd: request.cwd,
    deliveryId,
    messageSource: planMessageSource(
      planId,
      plan.title
    ),
    prompt: request.prompt,
    sandbox: "workspace-write"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl
  });
  if (userFeedback) await recordUserFeedbackChat(roleId, userFeedback, result);
  requireConfirmedPlanDelivery(result);
  const thread = result.data.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const resolvedId = String(thread?.id || "").trim();
  if (!resolvedId || resolvedId === request.threadId) return;
  const resolved = {
    id: resolvedId,
    title: typeof thread?.title === "string" ? thread.title : undefined,
    cwd: typeof thread?.cwd === "string" ? thread.cwd : undefined
  };
  await replacePlanTaskBindingForDelivery(currentRoleStorageApplication(), {
    roleId,
    planId,
    deliveryId: String(deliveryId || "").trim(),
    oldSessionId: request.threadId,
    oldInstanceBinding: request.instanceBinding,
    oldAgentType: request.agentAdapter,
    resolved
  });
  const warning = typeof result.data.warning === "string" ? result.data.warning.trim() : "";
  if (warning) {
    managerOperationalLog.record("warn", "plan_task_binding_replaced", {
      action: `${planId}:${request.threadId}->${resolvedId}`,
      result: warning
    });
  }
}

async function ensurePlanSecretaryTarget(
  runtime: GatewayRuntime,
  roleId: string,
  plan: PlanItem,
  eventId: string
): Promise<{ plan: PlanItem; target?: PlanSecretaryTarget }> {
  if (runtime.definition.codexPlanAssistantEnabled !== true) return { plan };
  const assignment = await ensurePlanSecretaryBindingForEvent(currentRoleStorageApplication(), {
    roleId,
    planId: plan.id,
    eventId,
    sessions: runtime.definition.codexPlanAssistantSessions,
    agentTargetId: resolvePrimaryAgentTarget(runtime.definition)?.id
  });
  return assignment.target ? {
    plan: assignment.plan,
    target: {
      ...assignment.target,
      model: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel)
    }
  } : { plan: assignment.plan };
}

async function sendPlanFeedbackToSecretary(
  runtime: GatewayRuntime,
  roleId: string,
  plan: PlanItem,
  target: PlanApprovalFeedbackSecretaryTarget,
  request: PlanApprovalFeedbackPersonaRequest,
  eventId: string,
  userFeedback?: PlanFeedbackRecord
): Promise<void> {
  const resolved = await resolvePlanSecretaryDeliveryTarget(runtime, roleId, plan, target, eventId);
  const result = await (resolvePrimaryAgentTarget(runtime.definition)?.binding ? handleAgentThreadRequest : handleLocalAgentThreadRequest)({
    action: "send",
    instanceBinding: resolvePrimaryAgentTarget(runtime.definition)?.binding,
    agentAdapter: resolved.target.agentAdapter,
    threadId: resolved.target.threadId,
    title: resolved.target.threadName,
    createIfMissing: true,
    cwd: resolved.target.workspace,
    messageSource: planMessageSource(
      plan.id,
      plan.title
    ),
    prompt: request.text,
    controlBlocks: resolved.initializationPrompt ? [resolved.initializationPrompt] : undefined,
    model: resolved.target.model,
    sandbox: "workspace-write"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl
  });
  if (userFeedback && request.kind === "full_feedback") await recordUserFeedbackChat(roleId, userFeedback, result);
  requireConfirmedPlanDelivery(result);
  if (resolved.initializationPrompt) {
    await markPlanSecretaryInitialized(runtime, resolved.target.threadId);
  }
}

async function sendPlanTaskCompletionToSecretary(
  runtime: GatewayRuntime,
  target: PlanSecretaryTarget,
  delivery: PlanTaskCompletionDelivery,
  prompt: string
): Promise<void> {
  const resolved = await resolvePlanSecretaryDeliveryTarget(
    runtime,
    delivery.roleId,
    delivery.plan,
    target,
    `completion:${delivery.sourceSessionId}:${delivery.sourceTurnId}`
  );
  const result = await (delivery.trustedRemoteSource || resolvePrimaryAgentTarget(runtime.definition)?.binding ? handleAgentThreadRequest : handleLocalAgentThreadRequest)({
    action: "send",
    instanceBinding: resolvePrimaryAgentTarget(runtime.definition)?.binding,
    agentAdapter: resolved.target.agentAdapter,
    threadId: resolved.target.threadId,
    title: resolved.target.threadName,
    createIfMissing: true,
    cwd: resolved.target.workspace,
    prompt,
    controlBlocks: resolved.initializationPrompt ? [resolved.initializationPrompt] : undefined,
    model: resolved.target.model,
    sandbox: "workspace-write",
    messageSource: planMessageSource(
      delivery.plan.id,
      delivery.plan.title,
      agentMessageSourceForSession(
        delivery.sourceSessionId,
        delivery.plan.taskBinding?.sessionTitle,
        delivery.plan.taskBinding?.agentType || "codex",
        "计划执行 Agent",
        delivery.sourceCwd
      )
    ),
    sourceThreadId: delivery.sourceSessionId,
    sourceAgentType: "plan_agent",
    responsePolicy: "required",
    responseInstruction: "消费本次阶段结果后，回复计划状态、已采取的下一步和仍需决定的事项"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl,
    ...(delivery.trustedRemoteSource ? { remoteSource: delivery.trustedRemoteSource } : {}),
    agentRequests
  });
  requireConfirmedPlanDelivery(result);
  if (resolved.initializationPrompt) {
    await markPlanSecretaryInitialized(runtime, resolved.target.threadId);
  }
}

async function markPlanSecretaryInitialized(runtime: GatewayRuntime, threadId: string): Promise<void> {
  let changed = false;
  runtime.definition.codexPlanAssistantSessions = (runtime.definition.codexPlanAssistantSessions ?? []).map((session) => {
    if (session.threadId !== threadId || session.agentTargetId !== resolvePrimaryAgentTarget(runtime.definition)?.id || session.initializedAt) return session;
    changed = true;
    return { ...session, initializedAt: new Date().toISOString() };
  });
  if (changed) await writeAdapterConfigFile(runtime.definition);
}

async function resolvePlanSecretaryDeliveryTarget(
  runtime: GatewayRuntime,
  roleId: string,
  plan: PlanItem,
  target: PlanSecretaryTarget | PlanApprovalFeedbackSecretaryTarget,
  eventId: string
): Promise<{ target: PlanSecretaryTarget; initializationPrompt?: string }> {
  const targetAgentAdapter = "agentAdapter" in target
    ? target.agentAdapter
    : isDshSessionId(target.threadId) ? "dsh" : "codex";
  const primaryTarget = resolvePrimaryAgentTarget(runtime.definition);
  if (!primaryTarget || primaryTarget.provider !== targetAgentAdapter || ("agentTargetId" in target && target.agentTargetId && target.agentTargetId !== primaryTarget.id)) throw new Error("Plan secretary does not belong to the primary Agent target.");
  const effective = effectiveInstanceDefinition(runtime.definition);
  const ownerWorkspace = primaryAgentSessionFields(effective, targetAgentAdapter).workspace;
  if (!sameCodexWorkspace(target.workspace, ownerWorkspace)) {
    throw new Error("Plan secretary session is outside the Primary Persona workspace.");
  }
  const previousSession = (runtime.definition.codexPlanAssistantSessions ?? [])
    .find((session) => session.threadId === target.threadId && session.agentTargetId === primaryTarget.id);
  if (!previousSession) throw new Error("Plan secretary is not configured for the primary Agent target.");
  const result = await (primaryTarget.binding ? handleAgentThreadRequest : handleLocalAgentThreadRequest)({
    instanceBinding: primaryTarget.binding,
    action: "resolve",
    agentAdapter: targetAgentAdapter,
    threadId: target.threadId,
    title: target.threadName,
    cwd: target.workspace,
    createIfMissing: true,
    lookupMode: "state_db"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan secretary session resolution failed with HTTP " + result.statusCode + "."));
  }
  const thread = result.data.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const threadId = String(thread?.id || "").trim();
  if (!threadId) throw new Error("Plan secretary session resolution did not return a session id.");
  const resolvedWorkspace = String(thread?.cwd || target.workspace);
  if (!sameCodexWorkspace(resolvedWorkspace, ownerWorkspace)) {
    throw new Error("Plan secretary session resolution returned a workspace different from the Primary Persona.");
  }
  const resolvedTarget: PlanSecretaryTarget = {
    agentTargetId: primaryTarget.id,
    agentAdapter: targetAgentAdapter,
    threadId,
    threadName: String(thread?.title || target.threadName),
    workspace: resolvedWorkspace,
    index: previousSession?.index ?? ("index" in target ? target.index : 1),
    model: target.model
  };
  if (threadId === target.threadId) return { target: resolvedTarget };

  const sessions = runtime.definition.codexPlanAssistantSessions ?? [];
  runtime.definition.codexPlanAssistantSessions = sessions.map((session) => session.threadId === target.threadId && session.agentTargetId === primaryTarget.id
    ? {
        ...session,
        ...(targetAgentAdapter === "dsh" ? { agentAdapter: "dsh" as const } : {}),
        threadId,
        threadName: resolvedTarget.threadName,
        workspace: resolvedTarget.workspace,
        initializedAt: undefined
      }
    : session);
  await writeAdapterConfigFile(runtime.definition);
  const bindingProjection = await currentRoleStorageApplication().queries.plan(roleId, plan.id, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.resolvePlanSecretaryDeliveryTarget.currentRoleStorageApplication__.queries.plan.timeoutMs", 30_000) });
  const currentBinding = bindingProjection?.plan.secretaryBinding;
  if (currentBinding?.sessionId === target.threadId) {
    await replacePlanSecretaryBindingForEvent(currentRoleStorageApplication(), {
      roleId,
      planId: plan.id,
      eventId,
      oldSessionId: target.threadId,
      binding: {
        ...currentBinding,
        agentType: targetAgentAdapter,
        sessionId: threadId,
        sessionTitle: resolvedTarget.threadName,
        workspace: resolvedTarget.workspace
      }
    });
  }

  const source = primaryAgentMessageSource(runtime.definition);
  const sourceThreadName = String(source.sessionName || runtime.definition.name || runtime.definition.id).trim();
  const count = Math.max(1, sessions.length);
  const index = resolvedTarget.index;
  return {
    target: resolvedTarget,
    initializationPrompt: codexPlanAssistantInitializationPrompt({
      roleId: String(runtime.definition.agentRoleId || ""),
      sourceAgentAdapter: normalizePlanBindingAgentType(source.agentAdapter),
      assistantAgentAdapter: targetAgentAdapter,
      sourceThreadId: source.sessionId,
      sourceThreadName,
      assistantThreadId: threadId,
      assistantThreadName: resolvedTarget.threadName,
      workspace: resolvedTarget.workspace,
      count,
      index,
      managerBaseUrl
    })
  };
}

function runtimeForRoleDelivery(roleId: string, gatewayId: string): GatewayRuntime {
  return localPersonaRuntimeForDelivery(runtimes.values(), roleId, gatewayId, roleIdForDefinition);
}

function deliverPlanTaskCompletion(delivery: PlanTaskCompletionDelivery): Promise<void> {
  return planTaskCompletionDelivery(delivery);
}

const activePlanFeedbackDeliveries = new Set<string>();
const activePlanFeedbackDeliveryFlights = new Map<string, Promise<void>>();
let planFeedbackRecoveryService: PlanFeedbackRecoveryService | undefined;
let planFeedbackDeliveryActive = false;

function planFeedbackDeliveryKey(roleId: string, planId: string, feedbackId: string): string {
  return `${roleId}:${planId}:${feedbackId}`;
}

type CurrentPlanFeedback = Readonly<{
  projection: RoleStoragePlanFeedbackProjection;
  record: PlanFeedbackRecord;
  revision: string;
}>;

function planFeedbackFromProjection(
  projection: RoleStoragePlanFeedbackProjection,
  feedbackId: string
): CurrentPlanFeedback {
  const record = projection.records.find((candidate) => candidate.id === feedbackId);
  if (!record) throw new Error(`Plan feedback not found: ${feedbackId}`);
  const revision = projection.recordRevisions[feedbackId];
  if (!revision) throw new Error(`Plan feedback revision is unavailable: ${feedbackId}`);
  return { projection, record, revision };
}

async function currentPlanFeedback(
  application: RoleStorageApplication,
  roleId: string,
  planId: string,
  feedbackId: string,
  signal?: AbortSignal
): Promise<CurrentPlanFeedback> {
  const projection = await application.queries.planFeedback(roleId, planId, {
    signal,
    timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.currentPlanFeedback.application.queries.planFeedback.timeoutMs", 30_000)
  });
  if (!projection) throw new Error(`Plan not found: ${planId}`);
  return planFeedbackFromProjection(projection, feedbackId);
}

function planQaStoragePort(application: RoleStorageApplication): PlanQaStoragePort {
  return Object.freeze({
    query: (roleId, planId, options) => application.queries.planFeedback(roleId, planId, options),
    updatePlan: async (roleId, planId, patch, context) => {
      const committed = await application.commands.updatePlan(roleId, planId, patch, context);
      return {
        plan: committed.projection.plan,
        revision: committed.projection.revision
      };
    },
    updateQaHandling: async (roleId, planId, record, qaHandling, context) => (
      await application.commands.updatePlanFeedbackQaHandling(
        roleId,
        planId,
        record,
        qaHandling,
        context
      )
    ).projection
  });
}

function planFeedbackMutationContext(
  operation: string,
  roleId: string,
  planId: string,
  feedbackId: string,
  expectedRevision: string,
  payload: unknown,
  signal?: AbortSignal
): RoleStorageCommandContext {
  return {
    idempotencyKey: roleStorageOperationKey(
      operation,
      roleId,
      `${planId}:${feedbackId}`,
      expectedRevision,
      JSON.stringify(payload) ?? "null"
    ),
    expectedRevision,
    signal,
    timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.planFeedbackMutationContext.timeoutMs", 30_000)
  };
}

function normalizedFeedbackMessage(message?: string): string | undefined {
  return String(message || "").trim() || undefined;
}

async function transitionPlanFeedbackDelivery(
  application: RoleStorageApplication,
  roleId: string,
  planId: string,
  feedbackId: string,
  status: Exclude<PlanFeedbackDeliveryStatus, "record_only">,
  message?: string,
  signal?: AbortSignal
): Promise<CurrentPlanFeedback> {
  const current = await currentPlanFeedback(application, roleId, planId, feedbackId, signal);
  const normalizedMessage = normalizedFeedbackMessage(message);
  if (current.record.deliveryStatus === "record_only" || current.record.deliveryStatus === "delivered") {
    return current;
  }
  if (current.record.deliveryStatus === status && current.record.deliveryMessage === normalizedMessage) {
    return current;
  }
  const committed = await application.commands.updatePlanFeedbackDelivery(
    roleId,
    planId,
    current.record,
    status,
    normalizedMessage,
    planFeedbackMutationContext(
      "manager-feedback-delivery",
      roleId,
      planId,
      feedbackId,
      current.revision,
      { status, message: normalizedMessage },
      signal
    )
  );
  return planFeedbackFromProjection(committed.projection, feedbackId);
}

async function transitionPlanFeedbackPostCommit(
  application: RoleStorageApplication,
  roleId: string,
  planId: string,
  feedbackId: string,
  status: PlanFeedbackPostCommit["status"],
  message?: string,
  signal?: AbortSignal,
  expectedAttempt?: number
): Promise<CurrentPlanFeedback> {
  const current = await currentPlanFeedback(application, roleId, planId, feedbackId, signal);
  const normalizedMessage = normalizedFeedbackMessage(message);
  if (current.record.postCommit?.status === "completed") return current;
  if (expectedAttempt !== undefined && (
    current.record.postCommit?.status !== "processing"
    || current.record.postCommit.attempts !== expectedAttempt
  )) {
    throw new Error(
      `Plan feedback post-commit attempt changed: ${feedbackId}; expected=${expectedAttempt}; `
      + `current=${current.record.postCommit?.attempts ?? "absent"}:${current.record.postCommit?.status ?? "absent"}.`
    );
  }
  if (current.record.postCommit?.status === status && current.record.postCommit.message === normalizedMessage) {
    return current;
  }
  const committed = await application.commands.updatePlanFeedbackPostCommit(
    roleId,
    planId,
    current.record,
    status,
    normalizedMessage,
    planFeedbackMutationContext(
      "manager-feedback-post-commit",
      roleId,
      planId,
      feedbackId,
      current.revision,
      { status, message: normalizedMessage, expectedAttempt },
      signal
    )
  );
  return planFeedbackFromProjection(committed.projection, feedbackId);
}

async function processPlanFeedbackPostCommit(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  inputRecord: PlanFeedbackRecord,
  signal?: AbortSignal,
  application: RoleStorageApplication = currentRoleStorageApplication()
): Promise<{ outcome: "handled" | "ignored"; record: PlanFeedbackRecord }> {
  let current = await currentPlanFeedback(application, roleId, inputRecord.planId, inputRecord.id, signal);
  let record = current.record;
  if (record.deliveryStatus === "record_only") return { outcome: "ignored", record };
  if (record.postCommit?.status === "completed") {
    return { outcome: record.qaHandling ? "handled" : "ignored", record };
  }
  current = await transitionPlanFeedbackPostCommit(
    application,
    roleId,
    record.planId,
    record.id,
    "processing",
    undefined,
    signal
  );
  record = current.record;
  const processingAttempt = record.postCommit?.attempts;
  if (!processingAttempt) throw new Error(`Plan feedback post-commit attempt is unavailable: ${record.id}`);
  try {
    const qaResult = await consumePlanQaFeedback({
      roleId,
      workflow: ensurePersonaPlanWorkflow(roleDir).workflow,
      storage: planQaStoragePort(application),
      feedback: record,
      signal,
      sendToTask: (request) => {
        const runtime = runtimeForRoleDelivery(
          roleId,
          String(record.gatewayId || gatewayId || "").trim()
        );
        return sendPlanFeedbackToTask(
          roleId,
          record.planId,
          runtime.definition.dshBaseUrl,
          request
        );
      },
      readTaskDelivery: inspectPlanFeedbackDelivery
    });
    if (qaResult.status === "dispatching") {
      throw new Error(`QA feedback ${record.id} is waiting for authoritative delivery readback.`);
    }
    current = await transitionPlanFeedbackPostCommit(
      application,
      roleId,
      record.planId,
      record.id,
      "completed",
      undefined,
      signal,
      processingAttempt
    );
    record = current.record;
    return { outcome: qaResult.outcome === "ignored" ? "ignored" : "handled", record };
  } catch (error) {
    try {
      await transitionPlanFeedbackPostCommit(
        application,
        roleId,
        record.planId,
        record.id,
        "failed",
        error instanceof Error ? error.message : String(error),
        signal,
        processingAttempt
      );
    } catch (transitionError) {
      throw new AggregateError(
        [error, transitionError],
        `Plan feedback post-commit failed and its failure state could not be committed: ${record.id}`
      );
    }
    throw error;
  }
}

function schedulePlanFeedbackPostCommit(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: PlanItem,
  inputRecord: PlanFeedbackRecord,
  application: RoleStorageApplication = currentRoleStorageApplication()
): void {
  if (inputRecord.deliveryStatus === "record_only" || !inputRecord.postCommit || inputRecord.postCommit.status === "completed") return;
  const deliveryKey = planFeedbackDeliveryKey(roleId, inputRecord.planId, inputRecord.id);
  const postCommitKey = `postcommit:${deliveryKey}`;
  if (activePlanFeedbackDeliveryFlights.has(postCommitKey)) return;
  const flight = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      const processed = await processPlanFeedbackPostCommit(roleDir, roleId, gatewayId, inputRecord, undefined, application);
      if (processed.outcome === "ignored"
        && processed.record.deliveryStatus !== "record_only"
        && processed.record.deliveryStatus !== "delivered") {
        await schedulePlanFeedbackDelivery(roleDir, roleId, gatewayId, plan, processed.record, application);
      }
    })
    .catch(() => {})
    .finally(() => {
      publishManagerEvent("plan_feedback_changed", { roleId, planId: inputRecord.planId, feedbackId: inputRecord.id });
      activePlanFeedbackDeliveryFlights.delete(postCommitKey);
    });
  activePlanFeedbackDeliveryFlights.set(postCommitKey, flight);
}

async function runPlanFeedbackDelivery(
  application: RoleStorageApplication,
  _roleDir: string,
  roleId: string,
  gatewayId: string,
  _plan: PlanItem,
  inputRecord: PlanFeedbackRecord
): Promise<PlanFeedbackRecord> {
  let current = await currentPlanFeedback(application, roleId, inputRecord.planId, inputRecord.id);
  let record = current.record;
  let authoritativePlan = current.projection.plan;
  if (record.deliveryStatus === "record_only" || record.deliveryStatus === "delivered") return record;
  if (!planFeedbackDeliveryActive) {
    return (await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      "pending",
      "Manager plan feedback delivery plugin is inactive."
    )).record;
  }
  if (record.deliveryStatus === "failed") {
    current = await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      "pending"
    );
    record = current.record;
    authoritativePlan = current.projection.plan;
  }

  try {
    const runtime = runtimeForRoleDelivery(roleId, gatewayId || String(record.gatewayId || "").trim());
    publishManagerEvent("plan_feedback_changed", { roleId, planId: authoritativePlan.id, feedbackId: record.id });
    const secretaryAssignment = await ensurePlanSecretaryTarget(
      runtime,
      roleId,
      authoritativePlan,
      `feedback:${record.id}`
    );
    const result = await deliverPlanApprovalFeedback({
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
      sendToTask: (request) => sendPlanFeedbackToTask(
        roleId,
        secretaryAssignment.plan.id,
        runtime.definition.dshBaseUrl,
        request,
        record.id,
        record
      ),
      readTaskDelivery: inspectPlanFeedbackDelivery,
      sendToSecretary: (target, request) => sendPlanFeedbackToSecretary(
        runtime,
        roleId,
        secretaryAssignment.plan,
        target,
        request,
        `feedback:${record.id}`,
        record
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
          planId: secretaryAssignment.plan.id,
          planTitle: secretaryAssignment.plan.title,
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
    });
    record = (await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      "delivered",
      result.message
    )).record;
    publishManagerEvent("plan_feedback_changed", { roleId, planId: authoritativePlan.id, feedbackId: record.id });
    return record;
  } catch (error) {
    if (error instanceof RoleStorageApplicationError) throw error;
    const pending = error instanceof PlanFeedbackDeliveryPendingError;
    if (pending) {
      planFeedbackRecoveryService?.allowRetry(roleId, authoritativePlan.id, record.id);
      planFeedbackRecoveryService?.queue("pending delivery readback");
    }
    record = (await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      pending ? "pending" : "failed",
      error instanceof Error ? error.message : String(error)
    )).record;
    publishManagerEvent("plan_feedback_changed", { roleId, planId: authoritativePlan.id, feedbackId: record.id });
    return record;
  }
}

function schedulePlanFeedbackDelivery(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: PlanItem,
  inputRecord: PlanFeedbackRecord,
  application: RoleStorageApplication = currentRoleStorageApplication()
): Promise<PlanFeedbackRecord> {
  const deliveryKey = planFeedbackDeliveryKey(roleId, inputRecord.planId, inputRecord.id);
  const existing = activePlanFeedbackDeliveryFlights.get(deliveryKey);
  if (existing) {
    return existing.then(async () => (
      await currentPlanFeedback(application, roleId, inputRecord.planId, inputRecord.id)
    ).record);
  }
  activePlanFeedbackDeliveries.add(deliveryKey);
  const operation = runPlanFeedbackDelivery(application, roleDir, roleId, gatewayId, plan, inputRecord);
  const flight = operation
    .then(() => undefined, () => undefined)
    .finally(() => {
      activePlanFeedbackDeliveries.delete(deliveryKey);
      activePlanFeedbackDeliveryFlights.delete(deliveryKey);
    });
  activePlanFeedbackDeliveryFlights.set(deliveryKey, flight);
  return operation;
}

async function scheduleAndWaitForPlanFeedbackDelivery(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: PlanItem,
  feedback: PlanFeedbackRecord
): Promise<void> {
  const scheduled = await schedulePlanFeedbackDelivery(roleDir, roleId, gatewayId, plan, feedback);
  if (scheduled.deliveryStatus === "delivered" || scheduled.deliveryStatus === "record_only") return;
  throw new Error(scheduled.deliveryMessage || "Plan feedback delivery did not complete.");
}

async function recoverPlanFeedbackCandidate(
  candidate: PlanFeedbackRecoveryCandidate,
  options: {
    signal?: AbortSignal;
    inspect: (request: PlanFeedbackRecoveryTaskRequest) => Promise<PlanFeedbackDeliveryInspection>;
    schedule: (candidate: PlanFeedbackRecoveryCandidate) => Promise<void>;
  }
): Promise<PlanFeedbackRecoveryOutcome> {
  const application = currentRoleStorageApplication();
  return recoverPlanFeedbackCandidateBase(candidate, {
    ...options,
    query: async (current, signal) => {
      const projection = await application.queries.planFeedback(
        current.roleId,
        current.plan.id,
        { signal, timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.query.application.queries.planFeedback.timeoutMs", 30_000) }
      );
      return projection ? { plan: projection.plan, records: projection.records } : null;
    },
    updateDelivery: (current, record, status, message, signal) => transitionPlanFeedbackDelivery(
      application,
      current.roleId,
      record.planId,
      record.id,
      status,
      message,
      signal
    ).then(committed => committed.record),
    postCommit: (current) => processPlanFeedbackPostCommit(
      current.roleDir,
      current.roleId,
      String(current.feedback.gatewayId || "").trim(),
      current.feedback,
      options.signal,
      application
    )
  });
}

function triggerGatewayRolePanelMessage(
  runtime: GatewayRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext?: Record<string, unknown>,
  deliveryEnv?: NodeJS.ProcessEnv,
  assertCurrent?: () => void
): Promise<void> {
  return triggerGatewayLocalAgentMessage(runtime, "role-panel", messageId, text, attachments, replyContext, deliveryEnv, assertCurrent);
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
  replyContext?: Record<string, unknown>,
  deliveryEnv?: NodeJS.ProcessEnv,
  assertCurrent?: () => void
): Promise<void> {
  assertCurrent?.();
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
  const logLabel = argumentPrefix === "plan-feedback" ? "plan feedback" : "role panel";
  const command = childCommand([
    `--${argumentPrefix}-message=${encodeURIComponent(messageId)}`,
    `--${argumentPrefix}-text-stdin`,
    `--${argumentPrefix}-role=${encodeURIComponent(roleId)}`,
    `--${argumentPrefix}-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--${argumentPrefix}-route-profile=${encodeURIComponent(routeProfileId)}`,
    `--${argumentPrefix}-attachments=${encodeURIComponent(JSON.stringify(attachments))}`,
    ...(replyContext ? [`--${argumentPrefix}-reply-context=${encodeURIComponent(JSON.stringify(replyContext))}`] : [])
  ]);
  appendLog(runtime, `${logLabel} requested: ${messageId}`);
  assertCurrent?.();
  return runLocalAgentMessageProcess({ command: command.command, args: command.args, shell: command.shell,
    cwd: rootDir, env: { ...envFor(runtime.definition), ...deliveryEnv }, text, messageId, label: logLabel,
    spawnProcess: (executable, args, options) => spawnGatewayCommand(runtime, {
      command: executable, args, shell: options.shell
    }, deliveryEnv),
    onLog: line => appendLog(runtime, line) });
}

function triggerGatewaySpeechMessage(runtime: GatewayRuntime, record: SpeechIngressRecord): Promise<ManagerSpeechDeliveryOutcome> {
  const endpoint = resolvePublishedPluginService(`endpoint.${record.messageAdapterType}@1`) as {
    instanceId: string; runAcceptedWork<T>(operation: () => Promise<T>): Promise<T>;
  } | undefined;
  if (!endpoint || typeof endpoint.runAcceptedWork !== "function") return Promise.resolve({ status: "recorded", reason: "endpoint_plugin_disabled", detail: "The original ingress record remains stored; this endpoint is not subscribed." });
  const messageId = record.id;
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = record.routeProfileId || runtime.definition.routeProfiles?.[0]?.id || runtime.definition.id;
  const ingressRoot = speechIngressStore.root;
  const environment = { ...envFor(runtime.definition), RABIROUTE_SPEECH_MESSAGES_DIR: ingressRoot,
    RABIROUTE_MESSAGE_ENDPOINT_INSTANCE_ID: endpoint.instanceId };
  const command = childCommand([
    `--speech-message=${encodeURIComponent(messageId)}`,
    `--speech-role=${encodeURIComponent(roleId)}`,
    `--speech-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--speech-route-profile=${encodeURIComponent(routeProfileId)}`
  ]);
  // The native endpoint's original lease includes the child's real close, even after timeout.
  return endpoint.runAcceptedWork(async () => {
    appendLog(runtime, `speech message requested: ${messageId}`);
    let stdoutText = "";
    const child = spawnGatewayCommand(runtime, command, environment);
    let closed;
    try {
      closed = await joinChildProcess(child, {
        timeoutMs: getTimeoutMs("deadline.manager.controlPlaneRoutes.triggerGatewaySpeechMessage", 40_000),
        timeoutError: () => new SpeechControlError(`Speech delivery timed out before the Desktop owner confirmed receipt: ${messageId}`, 504),
        stdout(textChunk) {
          stdoutText += textChunk;
          for (const line of textChunk.split(/\r?\n/).filter(Boolean)) {
            if (!line.startsWith(SPEECH_PROCESS_RESULT_MARKER)) appendLog(runtime, `speech: ${line}`);
          }
        },
        stderr(textChunk) {
          for (const line of textChunk.split(/\r?\n/).filter(Boolean)) appendLog(runtime, `speech error: ${line}`);
        }
      });
    } catch (error) {
      if (error instanceof SpeechControlError) throw error;
      throw new SpeechControlError(`Speech delivery process failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    const terminal = parseSpeechProcessResult(stdoutText);
    if (closed.code === SPEECH_EXIT_DELIVERED && terminal?.status === "delivered") {
      appendLog(runtime, `speech message delivered to Desktop owner: ${messageId}`);
      return terminal;
    }
    if (closed.code === SPEECH_EXIT_RECORDED && terminal?.status === "recorded") {
      appendLog(runtime, `speech message recorded without Agent delivery: ${messageId}; ${terminal.reason || "keyword policy"}`);
      return terminal;
    }
    throw new SpeechControlError(terminal?.detail || `speech message failed: code=${closed.code ?? "null"} signal=${closed.signal ?? "null"}`, 502);
  });
}

async function testGatewayAgentDelivery(
  id: string,
  request: { agentAdapterType?: AgentAdapterType; agentTargetId?: string }
): Promise<AgentDeliveryTestResult> {
  const runtime = runtimes.get(id);
  if (!runtime) throw new Error(`Gateway not found: ${id}`);
  if (runtime.definition.enabled === false) throw new Error("当前 Route 已停用，不能执行投递测试。");

  const requestedAdapter = parseAgentAdapterType(request.agentAdapterType);
  const targetId = request.agentTargetId ?? (requestedAdapter ? `local:${requestedAdapter}` : normalizeRouteAgentTargets(runtime.definition).primaryAgentTarget);
  const target = resolvePrimaryAgentTarget({ ...runtime.definition, primaryAgentTarget: targetId ?? "" });
  const adapter = target?.provider;
  if (!adapter || (requestedAdapter && requestedAdapter !== adapter)) {
    throw new Error("目标 Agent 未添加到当前 Route。");
  }
  if (resolvePublishedAgentManagerProvider(publishedPluginGeneration(), adapter).manifest.maturity === "stub") {
    throw new Error("该 Agent 当前只支持人工接力，无法确认真实投递。");
  }

  const deliveryId = randomUUID();
  const envelope = buildAgentDeliveryTestEnvelope({
    deliveryId,
    gatewayId: id,
    routeName: runtime.definition.name,
    agentAdapterType: adapter
  });
  envelope.deliveryId = deliveryId;
  const command = childCommand([
    `--direct-agent-envelope=${encodeURIComponent(JSON.stringify(envelope))}`,
    `--direct-agent-target=${encodeURIComponent(target!.id)}`,
    `--direct-agent-gateway=${encodeURIComponent(id)}`,
    `--agent-delivery-test=${deliveryId}`
  ]);
  appendLog(runtime, `agent delivery test requested: adapter=${adapter} deliveryId=${deliveryId}`);

  return await new Promise<AgentDeliveryTestResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawnGatewayCommand(runtime, command);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      void stopChildProcessTree(child)
        .catch(() => { child.kill(); })
        .finally(() => finish(() => reject(new Error(`投递测试超时：${deliveryId}`))));
    }, getTimeoutMs("deadline.manager.controlPlaneRoutes.testGatewayAgentDelivery", 60_000));
    deadline.unref?.();
    child.stdout.on("data", (data) => {
      const text = data.toString("utf8");
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `agent delivery test: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      const text = data.toString("utf8");
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `agent delivery test error: ${line}`);
      }
    });
    child.on("error", error => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => {
      const result = parseAgentDeliveryTestResult(stdout);
      if (code === 0
        && result?.status === "delivered"
        && result.deliveryId === deliveryId
        && result.agentAdapterType === adapter) {
        appendLog(runtime, `agent delivery test delivered: adapter=${adapter} deliveryId=${deliveryId}`);
        resolve(result);
        return;
      }
      const detail = result?.error
        || stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
        || `agent delivery test failed: code=${code ?? "null"} signal=${signal ?? "null"}`;
      reject(new Error(detail));
    }));
  });
}

function triggerGatewayDirectAgentMessage(id: string, envelope: RabiDeliveryEnvelope): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const args = [`--direct-agent-envelope=${encodeURIComponent(JSON.stringify(envelope))}`];
  const command = childCommand(args);
  appendLog(runtime, "remote agent result requested direct delivery");
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnGatewayCommand(runtime, command);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      void stopChildProcessTree(child)
        .catch(() => { child.kill(); })
        .finally(() => finish(() => reject(new Error("remote agent result delivery timed out after 30000 ms"))));
    }, getTimeoutMs("deadline.manager.controlPlaneRoutes.triggerGatewayDirectAgentMessage", 30_000));
    deadline.unref?.();
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
    child.on("error", error => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => {
      if (code === 0) {
        appendLog(runtime, "remote agent result delivered to local agent");
        resolve();
        return;
      }
      reject(new Error(`remote agent result delivery failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    }));
  });
}

function remoteAgentResultEnvelope(task: RemoteAgentTask, event: RemoteAgentTaskEvent): RabiDeliveryEnvelope {
  const lines = [
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
  return {
    messageSource: {
      type: "system",
      eventType: "remote_agent_task_result",
      eventName: "远端 Agent 任务结果",
      eventId: task.taskId,
      actorType: "远端 Agent",
      actorName: task.threadName || task.deviceId,
      actorId: task.deviceId,
      routeId: task.originGatewayId
    },
    messageContent: lines.join("\n")
  };
}

async function handleRemoteAgentTaskEvent(
  task: RemoteAgentTask,
  event: RemoteAgentTaskEvent,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  const runtime = runtimes.get(task.originGatewayId);
  if (runtime) {
    appendLog(runtime, `remote agent task ${task.taskId} ${event.status ?? task.status}: ${event.summary || event.message || event.error || ""}`.trim());
  }
  if (event.status === "completed" || event.status === "failed") {
    if (!runtime) {
      console.warn(`Remote Agent task ${task.taskId} finished but origin gateway was not found: ${task.originGatewayId}`);
      return;
    }
    if (signal.aborted) return;
    await triggerGatewayDirectAgentMessage(task.originGatewayId, remoteAgentResultEnvelope(task, event));
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

function speechServiceUrl(): string {
  return rabiGlobalConfig.read().rabiLinkRelay.speechServiceUrl;
}

async function inspectPlanFeedbackDelivery(
  request: PlanFeedbackRecoveryTaskRequest
): Promise<"accepted" | "in_progress" | "missing"> {
  if (!agentEndpointDelivery) throw new Error("Original plan feedback receipt owner is unavailable.");
  const original = await inspectOriginalPlanFeedbackReceipt(agentRequests, agentEndpointDelivery.options().managerInstanceId, request.deliveryId);
  if (original) return original;
  if (request.instanceBinding) throw new Error("Original remote plan feedback reservation is unavailable; current-session readback cannot prove the old delivery was not received.");
  const result = await handleAgentThreadRequest({
    action: "read",
    agentAdapter: request.agentAdapter,
    ...(request.instanceBinding ? { instanceBinding: request.instanceBinding } : {}),
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

function roleDirForApi(roleId: string): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    throw new Error("Missing role id.");
  }
  return roleFolderPath(managerRolesRoot(), safeRoleId);
}

/**
 * Resolves `payload.planAttachment` through its real plan storage owner.
 * Preserve attachment identity and the managed path; ordinary local files use
 * the sending boundary's existence, real-path and readability checks.
 */
async function resolveSendManagedPlanAttachment<T>(
  reference: { roleId?: string; planId: string; attachmentId: string },
  send: (file: { path: string; fileName: string }) => Promise<T>
): Promise<T> {
  const roleId = sanitizeRoleId(reference.roleId ?? "");
  if (!roleId) throw new Error("A managed plan attachment requires the owning roleId.");
  const roleDir = roleDirForApi(roleId);
  const plan = getPlan(roleDir, reference.planId);
  if (!plan) throw new Error(`Plan attachment plan was not found: ${reference.planId}.`);
  const attachment = plan.attachments.find(item => item.id === reference.attachmentId);
  if (!attachment) {
    throw new Error(`Plan attachment was not found on plan ${reference.planId}: ${reference.attachmentId}.`);
  }
  if (attachment.kind !== "image" && attachment.kind !== "file") {
    throw new Error(`Plan attachment ${reference.attachmentId} is not an image or file.`);
  }
  // The storage owner returns a canonical regular file contained in this plan's
  // active/archive roots; do not repeat its filesystem checks in the parent.
  const realFile = resolvePlanAttachmentFile(roleDir, plan.id, attachment);
  return await send({ path: realFile, fileName: attachment.name });
}

const roleKnowledgeCatalogRefreshes = new Map<string, Promise<void>>();

function requestRoleKnowledgeCatalogRefresh(roleDir: string): void {
  const key = path.resolve(roleDir);
  if (roleKnowledgeCatalogRefreshes.has(key)) return;
  const refresh = managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot(roleDir, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.requestRoleKnowledgeCatalogRefresh.managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot.timeoutMs", 300_000) })
    .then(() => undefined)
    .catch((error) => {
      managerOperationalLog.record("warn", "role_knowledge_catalog_refresh_failed", {
        action: key,
        error: managerOperationalError(error, rootDir)
      });
    })
    .finally(() => {
      if (roleKnowledgeCatalogRefreshes.get(key) === refresh) roleKnowledgeCatalogRefreshes.delete(key);
    });
  roleKnowledgeCatalogRefreshes.set(key, refresh);
}

function recalledKnowledgeForMessage(source: RegisterMessageGroupRequirementInput["source"]): KnowledgeRecallMatch[] {
  const roleId = String(source?.roleId || "").trim();
  if (!roleId) return [];
  try {
    const roleDir = roleDirForApi(roleId);
    const snapshot = roleKnowledgeSnapshotFromPublishedCatalog(roleDir, String(source.summary || ""), {
      roleId,
      archiveCompletedPlans: false,
      includePendingConsolidation: false
    });
    if (!snapshot) {
      requestRoleKnowledgeCatalogRefresh(roleDir);
      return [];
    }
    return snapshot.requiredReadItems
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

let gatewayDiagnosticsSnapshotService: GatewayDiagnosticsSnapshotService | undefined;

function activeGatewayDiagnosticsSnapshotService(): GatewayDiagnosticsSnapshotService {
  gatewayDiagnosticsSnapshotService ??= new GatewayDiagnosticsSnapshotService({
    capture: () => captureGatewayDiagnosticsWorkerInput(
      runtimes.values(),
      gatewayId => {
        const states = agentStateByGateway.get(gatewayId);
        return states && Object.fromEntries(Object.entries(states).filter(
          (entry): entry is [string, AgentRuntimeState] => entry[1] !== undefined));
      },
      routeCatalogPersonas()
    ),
    minRefreshIntervalMs: 5_000,
    timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.activeGatewayDiagnosticsSnapshotService.timeoutMs", 60_000),
    load: (input, options) => managerCatalogWorkerPool.run<GatewayDiagnosticsWorkerResult>({
      type: "gateway_diagnostics_snapshot",
      input
    }, options)
  });
  return gatewayDiagnosticsSnapshotService;
}

function standaloneGatewayPayload(
  includeDiagnostics = true,
  includeConfigDefinitions = includeDiagnostics
): Record<string, unknown> {
  const snapshotService = activeGatewayDiagnosticsSnapshotService();
  snapshotService.requestRefresh();
  const snapshot = snapshotService.read(includeDiagnostics);
  return measureSyncPerformanceOperation(
    includeDiagnostics
      ? PERFORMANCE_OPERATIONS.managerGatewaysBuildDiagnostics
      : PERFORMANCE_OPERATIONS.managerGatewaysBuildSummary,
    () => {
      const cachedById = new Map(snapshot.records.map(record => [String(record.id ?? ""), record]));
      const payload = buildStandaloneGatewayPayload(
        {
          runtimes: runtimes.values(),
          runtimeStatus: runtime => memoryOnlyGatewayRuntimeStatus(
            rootDir,
            runtime,
            cachedById.get(runtime.definition.id)
          ),
          routeDir: configRepository.domainRoot("route").value ? path.relative(rootDir, configRepository.requireDomainRoot("route")).replace(/\\/g, "/") : undefined,
          rolesDir: configRepository.domainRoot("roles").value ? path.relative(rootDir, configRepository.requireDomainRoot("roles")).replace(/\\/g, "/") : undefined,
          directoryDiagnostics: [configRepository.domainRoot("route").error, configRepository.domainRoot("roles").error].filter(Boolean),
          rawDirectoryConfig: { routeDir: configRepository.domainRoot("route").rawValue, rolesDir: configRepository.domainRoot("roles").rawValue }
        },
        { includeConfigDefinitions }
      );
      const data = payload.data as Record<string, unknown>;
      return {
        ...payload,
        data: {
          ...data,
          diagnosticsSnapshot: {
            revision: snapshot.revision,
            state: snapshot.state,
            refreshedAt: snapshot.refreshedAt,
            refreshStartedAt: snapshot.refreshStartedAt
          }
        }
      };
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

function publicWebguiLanAccessPayload(request: http.IncomingMessage): Record<string, unknown> {
  const config = rabiGlobalConfig.read().webguiLan;
  const addresses = localIpv4AddressEntries();
  const canManage = hasAuthenticatedConnectionRequest(request) || isLocalMachineRemoteAddress(request.socket.remoteAddress, addresses.map(item => item.address));
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

const managerClientTransportIdentity = createManagerTransportIdentity(() => ({
  applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
  managerInstanceId,
  metadataRevision: `${rabiGlobalConfig.getClientMetadataRevision()}:${managerPluginGenerationStatus?.id ?? "bootstrap"}`
}));

function managerHealthPayload(): Record<string, unknown> {
  const sourcePatches = managerSourcePatchStatus?.();
  const pluginGeneration = managerPluginGenerationStatus;
  const pluginReadiness = pluginReadinessWithProbeObservations(pluginGeneration?.readiness ?? {
    state: "degraded" as const,
    missingCapabilities: ["plugin-kernel-not-ready"]
  });
  const requiredRoutes = runtimes.values().filter(runtime =>
    runtime.definition.enabled === true
    && (Boolean(runtime.process) || sharedGatewayMessageAdapterTypes(runtime.definition, installedGatewayEndpointTypes).length > 0)
  );
  const routeCatalogStartup = routeCatalogStartupStatus();
  const routeLifecycle = {
    catalog: routeCatalogStartup,
    required: requiredRoutes.length,
    ready: requiredRoutes.filter(runtime => runtime.readiness === "ready").length,
    starting: requiredRoutes.filter(runtime => runtime.readiness === "starting").length,
    blocked: requiredRoutes.filter(runtime => runtime.readiness === "blocked").map(runtime => runtime.definition.id),
    failed: requiredRoutes.filter(runtime => runtime.readiness === "failed").map(runtime => runtime.definition.id)
  };
  const routesReady = routeCatalogStartup.state === "ready"
    && routeLifecycle.ready === routeLifecycle.required;
  const planStorageStartupSnapshot = planStorageStartupStatus();
  const planStorageStartup = publicPlanStorageStartupSnapshot(planStorageStartupSnapshot);
  const operationalLog = managerOperationalLog.status();
  const backgroundLifecycle = {
    planStorageStartup,
    performance: performanceMonitoring.initializationSnapshot(),
    routeCatalog: routeCatalogStartup,
    memoryConsolidation: memoryConsolidationScheduler?.failureSummary() ?? { backoff: 0, incidents: 0 },
    planFeedbackRecovery: planFeedbackRecoveryService?.failureSummary() ?? { backoff: 0, incidents: 0 },
    operationalLog,
    isolatedPluginProbes: [...managerPluginProbeDiagnostics.values()],
    configWatch: publicManagerWatchBrokerStatus(configWatchLifecycle),
    pluginPackageWatch: publicManagerWatchBrokerStatus(pluginPackageWatchLifecycle)
  };
  const watchIncidentCount = [configWatchLifecycle, pluginPackageWatchLifecycle]
    .filter(status => status.state === "degraded" || status.partial)
    .length;
  const backgroundIncidentCount = backgroundLifecycle.memoryConsolidation.incidents
    + backgroundLifecycle.planFeedbackRecovery.incidents
    + planStorageStartupSnapshot.incidents
    + (routeCatalogStartup.state === "degraded" ? routeCatalogStartup.incidents : 0)
    + (operationalLog.state === "degraded" ? 1 : 0)
    + watchIncidentCount
    + backgroundLifecycle.performance.incidents
    + backgroundLifecycle.isolatedPluginProbes.length;
  return {
    protocolVersion: 1,
    applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    managerInstanceId: managerInstanceId || undefined,
    managerBaseUrl: managerBaseUrl || undefined,
    health: buildManagerHealthSnapshot({
      pluginReadiness,
      planStorageReady: planStorageStartupSnapshot.state === "ready",
      planStoragePartial: planStorageStartupSnapshot.state === "partial",
      routesReady,
      routeReadyCount: routeLifecycle.ready,
      routeRequiredCount: routeLifecycle.required,
      blockedRouteIds: routeLifecycle.blocked,
      failedRouteIds: routeLifecycle.failed,
      backgroundIncidentCount,
      sourcePatchesReady: sourcePatches?.state === "ready"
    }),
    pluginReadiness,
    sourcePatches,
    routeLifecycle,
    backgroundLifecycle
  };
}

function metaPayload(): Record<string, unknown> {
  const version = rabiRoutePackageVersion();
  const globalConfig = rabiGlobalConfig.read();
  const healthPayload = managerHealthPayload();
  const pluginGeneration = managerPluginGenerationStatus;
  return {
    version,
    health: healthPayload.health,
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    apiTransport: managerClientTransportIdentity.protocolInfo(),
    applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    managerInstanceId: managerInstanceId || undefined,
    managerBaseUrl: managerBaseUrl || undefined,
    managerPort,
    lanDiscovery: managerLanDiscoveryStatus,
    pluginGeneration: pluginGeneration ? {
      id: pluginGeneration.id,
      sequence: pluginGeneration.sequence,
      readiness: healthPayload.pluginReadiness
    } : undefined,
    routeLifecycle: healthPayload.routeLifecycle,
    backgroundLifecycle: healthPayload.backgroundLifecycle,
    managerAutostart: managerShouldAutostart,
    rabiGuid: globalConfig.rabiGuid,
    rabiName: globalConfig.rabiName,
    agentUploads: globalConfig.agentUploads,
    timeoutOverrides: globalConfig.timeoutOverrides,
    webguiLan: {
      enabled: globalConfig.webguiLan.enabled,
      tokenConfigured: Boolean(globalConfig.webguiLan.accessToken),
      listeningOnLan: managerListensOnLan(managerHost),
      restartRequired: !managerHostOverride && globalConfig.webguiLan.enabled !== managerListensOnLan(managerHost)
    },
    rabiLinkRelay: publicRabiLinkRelayConfig(rabiLinkRelayConfigForMeta()),
    rabiLinkRelayRuntime: rabiLinkRelayRuntime.status(),
    managerRuntime: managerRuntimeDiagnosticsSummary(),
    hostPrivilege: {
      state: process.env.RABIROUTE_HOST_ELEVATED === "1" ? "administrator" : process.env.RABIROUTE_HOST_ELEVATED === "0" ? "limited" : "unknown",
      limitedCapabilities: process.env.RABIROUTE_HOST_ELEVATED === "0" ? ["home-assistant-vm", "home-assistant-core-recovery", "loopback-port-forwarding"] : []
    },
    performance: performanceMonitoring.status(),
    operationalLog: managerOperationalLog.status(),
    messageProcessingPersistence: messageProcessingBoardPersistence.status(),
    readWorkers: managerReadWorkerPool.status(),
    catalogWorkers: managerCatalogWorkerPool.status(),
    agentScanWorkers: agentManagerScanWorkers?.status() ?? {
      executionMode: "child_process",
      state: "stopped",
      active: 0,
      queued: 0,
      workers: 0,
      workerPids: [],
      spawnedWorkers: 0,
      globalActive: 0,
      globalMaxConcurrency: 0,
      maxConcurrency: 0,
      maxQueue: 0,
      timeoutMs: 0
    },
    performanceWorkers: managerPerformanceWorkerPool.status(),
    httpLimits: managerHttpLimits,
    peerLan: peerLanServer.status(),
    computerName: os.hostname()
  };
}

async function prewarmRolePlanCatalogs(): Promise<boolean> {
  const startedAt = Date.now();
  let roleDirectories: string[] = [];
  try {
    roleDirectories = await managerCatalogWorkerPool.run<string[]>({
      type: "role_directories",
      rolesRoot: managerRolesRoot()
    }, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.prewarmRolePlanCatalogs.managerCatalogWorkerPool.run.timeoutMs", 30_000) });
    let fulfilled = 0;
    for (const roleDir of roleDirectories) {
      try {
        knowledgeSearchService?.ensure(path.basename(roleDir), roleDir);
        await managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot(roleDir, { timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.prewarmRolePlanCatalogs.managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot.timeoutMs", 300_000) });
        await knowledgeSearchService?.reload(path.basename(roleDir), roleDir);
        fulfilled += 1;
      } catch (error) {
        managerOperationalLog.record("warn", "role_plan_catalog_prewarm_failed", {
          action: roleDir,
          error: managerOperationalError(error, rootDir)
        });
      }
    }
    managerOperationalLog.record("info", "role_plan_catalogs_prewarmed", {
      durationMs: Date.now() - startedAt,
      result: `roles=${roleDirectories.length}; fulfilled=${fulfilled}`
    });
    return fulfilled === roleDirectories.length;
  } catch (error) {
    managerOperationalLog.record("warn", "role_plan_catalogs_prewarm_failed", {
      durationMs: Date.now() - startedAt,
      result: `roles=${roleDirectories.length}`,
      error: managerOperationalError(error, rootDir)
    });
    return false;
  }
}

export type StartManagerOptions = {
  instanceLock?: ManagerInstanceLock;
  planStorageStartupLifecycle?: PlanStorageStartupLifecycle;
  routeCatalogStartupLifecycle?: RouteCatalogStartupLifecycle;
  routeCatalogStartupAttemptFactory?: ConstructorParameters<typeof RouteCatalogStartupLifecycle>[0]["attemptFactory"];
};

export async function startManager(options: StartManagerOptions = {}): Promise<void> {
  roleKnowledgeCatalogsReady = false;
  let activeServer!: http.Server;
  let shuttingDown = false;
  const managerStartingRequest = (_request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("retry-after", "1");
    response.end(`${JSON.stringify({
      code: -1,
      state: "starting",
      message: "RabiRoute Manager is starting."
    })}\n`);
  };
  const managerStoppingRequest = (_request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("retry-after", "1");
    response.end(`${JSON.stringify({
      code: -1,
      state: "stopping",
      message: "RabiRoute Manager is stopping."
    })}\n`);
  };
  let stopPluginPackagePreparation: (() => Promise<void>) | undefined;
  let stopAgentScanWorkers: (() => Promise<void>) | undefined;
  const managerRuntimeOwner = new ManagerRuntimeOwner<ActiveStorageLifecycleGeneration>({
    fenceIngress(reason) {
      shuttingDown = true;
      // Cancel unpublished metadata before any admitted request owner joins its tail.
      // The catalog resource below still awaits the same memoized disposal.
      void stopPluginPackagePreparation?.().catch(() => {});
      void stopAgentScanWorkers?.().catch(() => {});
      // Fence purely queued work before plugin retirement waits for its callers.
      // The original resource owner joins this same memoized close at the end.
      void agentRequests.close().catch(() => {});
      agentRequestRouteReconciliation.stopAccepting();
      activeServer?.removeAllListeners("request");
      activeServer?.on("request", managerStoppingRequest);
      closeManagerEventClients();
      managerOperationalLog.record("info", "manager_ingress_fenced", { result: reason });
    },
    publish(publication) {
      if (activeStorageLifecycleGeneration) {
        throw new Error("A Manager runtime generation is already published.");
      }
      activeServer.removeAllListeners("request");
      activeServer.on("request", publication.requestHandler);
      activeStorageLifecycleGeneration = publication;
    },
    unpublish(publication) {
      if (activeStorageLifecycleGeneration === publication) {
        activeStorageLifecycleGeneration = undefined;
      }
      activeServer.removeListener("request", publication.requestHandler);
    },
    onResourceStopError(owner, error) {
      managerOperationalLog.record("error", "manager_resource_stop_failed", {
        action: owner,
        error: managerOperationalError(error, rootDir)
      });
    }
  });
  const failManagerStartup = async (phase: string, error: unknown): Promise<never> => {
    await managerRuntimeOwner.teardown(phase, error);
    throw error;
  };
  managerRuntimeOwner.register("operational_log_flush", () => managerOperationalLog.flush());
  managerRuntimeOwner.register("agent_request_store", () => agentRequests.close());
  managerRuntimeOwner.register("agent_request_route_reconciliation", () => agentRequestRouteReconciliation.stop());
  const activeGatewayStatuses = activeGatewayStatusSnapshotService();
  managerRuntimeOwner.register("gateway_status_snapshots", () => {
    activeGatewayStatuses.stop();
    if (gatewayStatusSnapshotService === activeGatewayStatuses) gatewayStatusSnapshotService = undefined;
  });
  managerRuntimeOwner.register("data_mutation_audit_sink", () => uninstallDataMutationAuditSink());
  knowledgeSearchService = new KnowledgeSearchService({
    readDelta: (roleDir, previous, signal) => managerCatalogWorkerPool.run({
      type: "knowledge_search_delta", roleDir, previous
    }, { signal, timeoutMs: getTimeoutMs("backend.manager.controlPlaneRoutes.readDelta.managerCatalogWorkerPool.run.timeoutMs", 300_000) }),
    onError: (roleId, error) => managerOperationalLog.record("warn", "knowledge_search_refresh_failed", {
      action: roleId, error: managerOperationalError(error, rootDir)
    })
  });
  const activeKnowledgeSearch = knowledgeSearchService;
  managerRuntimeOwner.register("knowledge_search", async () => {
    await activeKnowledgeSearch.close();
    if (knowledgeSearchService === activeKnowledgeSearch) knowledgeSearchService = undefined;
  });
  let signalExitScheduled = false;
  const shutdownManager = (reason: string): void => {
    console.log(`gateway-manager shutting down: ${reason}`);
    managerOperationalLog.record("info", "manager_shutdown_requested", { result: reason });
    const teardownFlight = managerRuntimeOwner.teardown(`signal:${reason}`);
    if (signalExitScheduled) return;
    signalExitScheduled = true;
    void teardownFlight.then(
      () => process.exit(process.exitCode ?? 0),
      error => {
        process.exitCode = 1;
        console.error(error);
        process.exit(1);
      }
    );
    const forcedExit = setTimeout(
      () => process.exit(1),
      Math.min(2_147_483_647, getTimeoutMs("backend.manager.managerRuntimeOwner.DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS", DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS) + 1_000)
    );
    forcedExit.unref();
  };
  let removeSignalHandlers = (): void => {};
  try {
    removeSignalHandlers = installManagerSignalHandlers(shutdownManager);
    managerRuntimeOwner.register("signal_handlers", () => removeSignalHandlers());
  } catch (error) {
    await failManagerStartup("manager_signal_handler_acquisition", error);
  }
  try {
    const managerCordisRoot = getBuiltinManagerCordisRoot();
    managerRuntimeOwner.register("cordis_root", () => managerCordisRoot.dispose());
    await managerCordisRoot.ensure(
      MANAGER_SHARED_RESOURCES_RUNTIME_KEY,
      mountManagerSharedResourcesRuntime(messageProcessingBoardPersistence)
    );
  } catch (error) {
    await failManagerStartup("manager_shared_resources_acquisition", error);
  }
  if (!managerReadOnly) migrateLanAgentSharedCredential({
    registryPath: path.join(rootDir, "data", ".runtime", "lan-agent-tasks.json"),
    markerPath: path.join(rootDir, "data", ".runtime", "lan-agent-credential-migration.json"),
    rotateWebguiToken: () => {
      const current = rabiGlobalConfig.read().webguiLan;
      rabiGlobalConfig.patch({ webguiLan: { ...current, accessToken: generateWebguiAccessToken() } });
    }
  });
  activeServer = http.createServer(managerStartingRequest);
  managerRuntimeOwner.register("http_server", () => activeServer.listening
    ? new Promise<void>(resolve => activeServer.close(() => resolve()))
    : Promise.resolve());
  activeServer.requestTimeout = getTimeoutMs("http.outerRequest", 30 * 60 * 1000); // Per-request body deadlines retain the ordinary 30-second limit.
  activeServer.headersTimeout = managerHttpLimits.headersTimeoutMs;
  activeServer.keepAliveTimeout = managerHttpLimits.keepAliveTimeoutMs;
  activeServer.maxRequestsPerSocket = managerHttpLimits.maxRequestsPerSocket;
  try {
    const endpoint = await listenManagerEndpoint({
      server: activeServer,
      host: managerHost,
      policy: managerPortPolicy
    });
    managerPort = endpoint.port;
    managerBaseUrl = endpoint.baseUrl;
    managerInstanceId = options.instanceLock?.owner.ownerId ?? randomUUID();
    process.env.GATEWAY_MANAGER_PORT = String(managerPort);
    process.env.GATEWAY_MANAGER_URL = managerBaseUrl;
    configRepository.setManagerPort(managerPort);
  } catch (error) {
    await failManagerStartup("manager_endpoint_acquisition", error);
  }
  const restorePlanUpdateExecutor = createPlanUpdateExecutorRestorer(path.join(rootDir, "data", "plugins", ".runtime"));
  const roleStorageApplication = await (async (): Promise<RoleStorageApplication> => {
    try {
      const application = new RoleStorageApplication({
        rolesRoot: managerRolesRoot,
        applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
        managerInstanceId,
        currentIdentity: () => managerInstanceId
          ? Object.freeze({
              applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
              managerInstanceId
            })
          : null,
        acquirePlanUpdateExecutor: () => {
          const service = resolvePublishedPluginService("manager.persona.plan-update@1") as PlanUpdateExecutorService | undefined;
          return service?.acquirePlanUpdateExecutor();
        },
        restorePlanUpdateExecutor
      });
      managerRuntimeOwner.register("role_storage", () => application.stop());
      return application;
    } catch (error) {
      return await failManagerStartup("role_storage_acquisition", error);
    }
  })();
  const {
    planStorageStartupLifecycle,
    routeCatalogStartupLifecycle
  } = await (async (): Promise<{
    planStorageStartupLifecycle: PlanStorageStartupLifecycle;
    routeCatalogStartupLifecycle: RouteCatalogStartupLifecycle;
  }> => {
    try {
      const planLifecycle = options.planStorageStartupLifecycle ?? new PlanStorageStartupLifecycle({
      rolesRoot: managerRolesRoot,
      readOnly: managerReadOnly,
      attemptTimeoutMs: getTimeoutMs("startup.planStorage", Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_TIMEOUT_MS) || 180_000),
      retryBaseMs: Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_RETRY_BASE_MS) || undefined,
      retryMaxMs: Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_RETRY_MAX_MS) || undefined,
      terminateTimeoutMs: getTimeoutMs("backend.manager.storageStartupProcess.createStorageStartupProcess.terminateTimeoutMs", Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_TERMINATE_TIMEOUT_MS) || 5_000),
      limits: {
        ...(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_ITEM_TIMEOUT_MS
          ? { itemTimeoutMs: getTimeoutMs("backend.manager.progressivePlanStorageStartup.attempt.itemTimeoutMs", Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_ITEM_TIMEOUT_MS)) } : {}),
        ...(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_BATCH_TIMEOUT_MS
          ? { batchTimeoutMs: getTimeoutMs("backend.manager.progressivePlanStorageStartup.attempt.batchTimeoutMs", Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_BATCH_TIMEOUT_MS)) } : {})
      },
      onStatus: snapshot => {
        const rolesRoot = configRepository.domainRoot("roles").value;
        if (rolesRoot) publishStartupPlanConflicts(rolesRoot, snapshot.summary);
        publishManagerEvent("plan_storage_startup_changed", publicPlanStorageStartupSnapshot(snapshot));
        const level = snapshot.state === "degraded" ? "error" : snapshot.state === "partial" ? "warn" : "info";
        managerOperationalLog.record(level, `plan_storage_startup_${snapshot.state}`, {
          durationMs: snapshot.startedAt && snapshot.completedAt
            ? Math.max(0, Date.parse(snapshot.completedAt) - Date.parse(snapshot.startedAt))
            : undefined,
          result: `attempt=${snapshot.attempt}; state=${snapshot.state}; roles=${snapshot.summary?.roles ?? 0}; migrated=${snapshot.summary?.migrated ?? 0}; reconciled=${snapshot.summary?.reconciled ?? 0}; failures=${snapshot.summary?.failures.length ?? 0}; packageConflicts=${snapshot.summary?.packageConflicts?.length ?? 0}`,
          error: snapshot.lastError ? managerOperationalError(new Error([
            snapshot.lastError,
            ...(snapshot.summary?.failures ?? []).slice(0, 10)
          ].join("\n")), rootDir) : undefined
        });
      }
      });
      managerRuntimeOwner.register("plan_storage_startup", () => planLifecycle.stop());
      const routeLifecycle = options.routeCatalogStartupLifecycle ?? new RouteCatalogStartupLifecycle({
      attemptFactory: options.routeCatalogStartupAttemptFactory,
      input: () => ({
        rootDir,
        routeRoot: managerRouteRoot(),
        rolesRoot: managerRolesRoot(),
        managerPort,
        readOnly: managerReadOnly
      }),
      apply: applyRouteCatalogSnapshot,
      attemptTimeoutMs: getTimeoutMs("startup.routeCatalog", Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_TIMEOUT_MS) || (process.platform === "win32" ? 120_000 : 30_000)),
      retryBaseMs: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_RETRY_BASE_MS) || undefined,
      retryMaxMs: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_RETRY_MAX_MS) || undefined,
      maxAttempts: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_MAX_ATTEMPTS) || undefined,
      terminateTimeoutMs: getTimeoutMs("startup.routeTerminate", Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_TERMINATE_TIMEOUT_MS) || 5_000),
      onStatus: snapshot => {
        publishManagerEvent("route_catalog_startup_changed", snapshot);
        syncRunningGateways();
      },
      onFailure: (error, snapshot) => {
        managerOperationalLog.record("error", "route_catalog_startup_failed", {
          result: `attempt=${snapshot.attempt}; code=${snapshot.lastErrorCode ?? "unknown"}; Manager control plane stays live`,
          error: managerOperationalError(error, rootDir)
        });
      }
      });
      managerRuntimeOwner.register("route_catalog_startup", () => routeLifecycle.stop());
      return {
        planStorageStartupLifecycle: planLifecycle,
        routeCatalogStartupLifecycle: routeLifecycle
      };
    } catch (error) {
      return await failManagerStartup("startup_lifecycle_acquisition", error);
    }
  })();
  try {
  let managerPluginKernel: GenerationRuntime | undefined;
  resolvePublishedPluginService = capability => managerPluginKernel?.current().services.services.get(capability)?.value;
  publishedPluginGeneration = () => managerPluginKernel?.current();
  const managerPluginProcessLeases = new ProcessLeaseRegistry();
  managerRuntimeOwner.register("manager_plugin_process_leases", () => managerPluginProcessLeases.disposeAll());
  let loadedManagerPluginProfile: LoadedPluginProfile | undefined;
  let pendingManagerPluginProfile: LoadedPluginProfile | undefined;
  let refreshStartupPresentation = (): void => {};
  let computerPresentationTheme: ComputerPresentationTheme | undefined;
  let applyComputerPresentationTheme = async (): Promise<void> => {};
  const computerThemePending = new Set<Promise<unknown>>();
  const computerThemeLog = managerOperationalLog.bind("computer.presentation", "warn");
  const captureComputerPresentationTheme = (): void => {
    try {
      const current = desktopSettings.read();
      computerPresentationTheme = {theme:current.theme,customThemes:current.customThemes};
    } catch (error) {
      computerThemeLog.record("computer_theme_read_failed",error,value=>({error:managerOperationalError(value,packageRoot)}));
    }
  };
  captureComputerPresentationTheme();

  const publishDesktopSettingsEvent = (eventType: string, data: unknown): void => {
    publishManagerEvent(eventType, data);
    if (eventType === "desktop_settings_changed") {
      refreshStartupPresentation();
      captureComputerPresentationTheme();
      const pending = applyComputerPresentationTheme().catch(error=>computerThemeLog.record("computer_theme_apply_failed",error,value=>({error:managerOperationalError(value,packageRoot)})));
      computerThemePending.add(pending);
      void pending.then(()=>computerThemePending.delete(pending),()=>computerThemePending.delete(pending));
    }
  };
  let startupRequiredGenerationId: string | undefined;
  const managerPluginProfilePublication = new PluginProfilePublication();
  let managerPluginDiagnostics: readonly unknown[] = [];
  const capturePluginGeneration = (generation: PluginGeneration): void => {
    const metadata = managerPluginProfilePublication.capture(pendingManagerPluginProfile ?? loadedManagerPluginProfile, generation);
    loadedManagerPluginProfile = metadata.profile;
    gatewayRouteDeclarationPackages = loadedManagerPluginProfile?.packages ?? [];
    const loadFailures = loadedManagerPluginProfile?.loadFailures ?? [];
    managerPluginGenerationStatus = Object.freeze({
      id: generation.id,
      sequence: generation.sequence,
      readiness: loadFailures.length || metadata.diagnostics.length
        ? Object.freeze({ ...generation.readiness, state: "degraded" as const })
        : generation.readiness
    });
    managerPluginDiagnostics = Object.freeze([
      ...generation.records.filter(record => record.status !== "active" || record.error),
      ...loadFailures,
      ...metadata.diagnostics
    ]);
    if (loadedManagerPluginProfile) webPluginModules.update(loadedManagerPluginProfile, generation);
  };
  let managerServicesReady = false;
  let managerListenerReady = false;
  let resolveWearableCompanionStartup = (): void => {};
  const wearableCompanionStartupReady = new Promise<void>(resolve => {
    resolveWearableCompanionStartup = resolve;
  });
  let syncActiveRabiLinkRelay = async (): Promise<void> => {};
  let recordManagerHttpRequest = (_pathname: string, _statusCode: number, _durationMs: number, _requestId: string, _responseBytes?: number): void => {};



  let startActivePlanFeedbackRecovery = (): void => {};
  const managerApplicationRouteKey = {};
  const managerPluginRoutes = new ManagerPluginRouteRegistry(() => new Set(
    managerPluginKernel?.current().records.filter(record => record.status === "active")
      .map(record => record.identity.activationId) ?? []
  ), {
    identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
      managerInstanceId, pluginGenerationId: managerPluginKernel?.current().id ?? "initializing" }),
    changed: snapshot => publishManagerEvent("api.catalog.changed", {
      applicationGenerationId: snapshot.applicationGenerationId, managerInstanceId: snapshot.managerInstanceId,
      pluginGenerationId: snapshot.pluginGenerationId, catalogRevision: snapshot.catalogRevision,
      catalogDigest: snapshot.catalogDigest
    })
  }, { applicationOwnerKey: managerApplicationRouteKey });
  const managerApplicationRoutes = managerPluginRoutes.createApplicationOwner(managerApplicationRouteKey, "host:manager-bootstrap");
  const listenerPublicationHost = createGatewayListenerPublicationHost(managerPluginRoutes);
  gatewayListenerPublicationHost = listenerPublicationHost;
  managerRuntimeOwner.register("gateway_listener_publication", () => {
    listenerPublicationHost.dispose();
    if (gatewayListenerPublicationHost === listenerPublicationHost) gatewayListenerPublicationHost = undefined;
  });
  const lanAgentAuthority = new LanAgentAuthority({ resolveComputerDefinition: () => resolvePublishedPluginService("manager.computer-settings-definition@1") as ComputerSettingsDefinition | undefined, statePath: path.join(rootDir, "data", ".runtime", "lan-agent-authority.json") });
  const agentUploadStore = new AgentUploadStore({ rootDir: path.join(rootDir, "data", ".runtime", "agent-uploads"), maxFileBytes: rabiGlobalConfig.read().agentUploads.maxFileMiB * 1024 * 1024 });
  const assertUploadAuthorized = (source: TrustedLanAgentSource): void => {
    if (!lanAgentAuthority.getNodeAuthorization(source.nodeId)) throw new Error("Remote computer credential was revoked.");
  };
  const lanAgentReleaseStore = new LanAgentReleaseStore({ immutablePackage:Boolean(managerHostIdentity), rootDir, agentRoot: path.join(packageRoot, "apps", "rabi-agent"), pluginSourceRoot: packageRoot });
  // Rebuildable per-source display cache; settings and execution stay with each original Manager.
  const computerPeerRows = new Map<string, Record<string, unknown>[]>();
  const listPeerComputers = async () => {
    let directory: Awaited<ReturnType<NonNullable<typeof activePeerTunnel>["directory"]>> | undefined;
    try { directory = await activePeerTunnel?.directory(); if (!directory) throw new Error("Peer directory is not ready."); }
    catch {
      const message = "Peer directory is unavailable; previously discovered computers have unknown status.";
      return { computers: [...computerPeerRows.values()].flatMap(rows => rows.map(row => ({...row,status:"unknown",issue:message}))), sourceErrors: [{ownerDeviceId:"peers",message}] };
    }
    const self = rabiLinkRelayConfigForMeta().deviceId;
    const peers = directory.peers.filter(peer => peer.deviceId !== self);
    const currentSources = new Set(peers.map(peer => peer.deviceId));
    for (const id of computerPeerRows.keys()) if (!currentSources.has(id)) computerPeerRows.delete(id);
    const settled = await Promise.all(peers.map(async (peer): Promise<{ rows: Record<string, unknown>[]; error?: {ownerDeviceId:string;message:string} }> => {
      try {
        if (!peer.online) {
          const previous = computerPeerRows.get(peer.deviceId);
          return { rows: previous?.map(row => ({ ...row, status: "offline", connected: false })) ?? [{ id: `peer:${peer.deviceId}`, instanceId: "", ownerDeviceId: peer.deviceId, name: peer.name, kind: "host", local: false, status: "offline" }] };
        }
        const response = await requestPeerManagerApi(peer.deviceId, "GET", "/api/lan-agent/instances") as { instances?: import("../shared/agentInstance.js").AgentInstance[] };
        if (!Array.isArray(response.instances)) throw new Error("Peer instance directory is incomplete.");
        const host = response.instances.find(instance => instance.local)?.instanceId;
        const rows = response.instances.map(instance => ({ ...instance, id: instance.local ? `peer:${peer.deviceId}` : `${host ?? peer.deviceId}/${instance.instanceId}`,
          ownerDeviceId: peer.deviceId, ownerName: peer.name, name: instance.name || instance.hostname || (instance.local ? peer.name : instance.instanceId),
          kind: instance.local ? "host" : "node", local: false, status: instance.connected ? "online" : "offline", capabilities: instance.computerCapabilities ?? [] }));
        computerPeerRows.set(peer.deviceId, rows); return { rows };
      } catch {
        const message = "This host's computer directory could not be read; its status is unknown.";
        const rows = computerPeerRows.get(peer.deviceId)?.map(row => ({ ...row, status: "unknown", issue: message }))
          ?? [{ id: `peer:${peer.deviceId}`, instanceId: "", ownerDeviceId: peer.deviceId, name: peer.name, kind: "host", local: false, status: "unknown", issue: message }];
        return { rows, error: { ownerDeviceId: peer.deviceId, message } };
      }
    }));
    return { computers: settled.flatMap(item => item.rows), sourceErrors: settled.flatMap(item => item.error ? [item.error] : []) };
  };
  const lanAgentRegistry: LanAgentRegistry = new LanAgentRegistry({
    listPeerComputers,
    onComputerChanged: instanceId => publishManagerEvent("computer_control_changed",{instanceId}),
    onComputerSourceCleanupError: (instanceId,error) => managerOperationalLog.record("warn","computer_source_cleanup_unconfirmed",{target:{type:"computer",id:instanceId},error:managerOperationalError(error,packageRoot)}),
    executionSource: request => {
      const source = getTrustedLanAgentSource(request);
      if (source) return {sourceId:computerAgentSourceId(source.nodeId,source.provider,source.sessionId),sourceLabel:source.sessionName || source.provider || source.nodeId,taskId:source.sessionId,connectionId:lanAgentRegistry.computerConnectionId(source.nodeId)};
      const peer = rabiLinkAgentTaskSource(request,rabiLinkRelayConfigForMeta(),managerHostIdentity?.applicationGenerationId ?? managerInstanceId);
      return peer ? {sourceId:`peer:${peer.sourceDeviceId}`,sourceLabel:peer.sourceDeviceId} : {sourceId:`manager:${managerInstanceId}`,sourceLabel:"Rabi PC"};
    },
    statePath: path.join(rootDir, "data", ".runtime", "lan-agent-tasks.json"),
    computerFeaturePolicy:(instanceId,feature)=>instanceId===lanAgentRegistry.localInstanceId?configRepository.readComputerFeaturePolicy(feature):lanAgentAuthority.getComputerFeaturePolicy(instanceId,feature),
    computerSettings: (instanceId, refresh) => instanceId === lanAgentRegistry.localInstanceId ? configRepository.readComputerSettings(refresh) : lanAgentAuthority.getComputerSettings(instanceId, refresh),
    computerSettingsRaw: instanceId => instanceId === lanAgentRegistry.localInstanceId ? configRepository.readComputerSettingsRaw() : lanAgentAuthority.getComputerSettingsRaw(instanceId),
    computerExecutionSettings: instanceId => instanceId === lanAgentRegistry.localInstanceId ? configRepository.readComputerExecutionSettings() : lanAgentAuthority.getComputerExecutionSettings(instanceId),
    computerSettingsDefinition: () => configRepository.getComputerSettingsDefinition(),
    patchComputerSettings: (instanceId, patch, revision, restorePaths) => instanceId === lanAgentRegistry.localInstanceId ? configRepository.patchComputerSettings(patch, revision, restorePaths) : lanAgentAuthority.patchComputerSettings(instanceId, patch, revision, restorePaths),
    createLocalComputer: (instanceId, emit) => {
      const computer = new ManagerLocalComputer({
      instanceId, getSettings: () => configRepository.readComputerSettingsRaw(),
      getDefinition:()=>configRepository.getComputerSettingsDefinition(),
      restoreDesktopRelease: async () => {
        const selected = lanAgentReleaseStore.desktopResourceSelection();
        return { revision: selected.revision, version: selected.version, ...(selected.digest ? { reference: selected.digest } : {}), ...(selected.qtPackageRef ? { qtPackageRef: selected.qtPackageRef } : {}) };
      },
      commitDesktopRelease: async (release, expectedRevision) => {
        return lanAgentReleaseStore.selectDesktopResourceRelease(release.digest ?? null, expectedRevision, release.qtPackageRef ?? null);
      },
      resolveDesktopRelease: createDesktopResourceResolver({ native: lanAgentReleaseStore, packages: () => managerPluginPackageCatalog }),
      getPresentationTheme: () => computerPresentationTheme,
      ...(process.platform === "win32" ? {qtPresentation: {command:path.join(packageRoot,"desktop-runtime","python","python.exe"),args:[path.join(packageRoot,"desktop-runtime","rabiroute_tray","computer_control_overlay.py")]}} : {}),
      stateDirectory: path.join(rootDir, "data", ".runtime", "local-computer"), emit, timeout: getTimeoutMs
      });
      applyComputerPresentationTheme = () => computer.setPresentationTheme(computerPresentationTheme);
      return computer;
    },
    authenticateNode: token => {
      const admission = rabiGlobalConfig.getLanAgentAdmissionPolicy();
      const lease = admission.enabled ? lanAgentAuthority.acquireConnectionLease(token) : null;
      return lease ? { nodeId: lease.nodeId, incarnation: JSON.stringify([admission.incarnation, lease.incarnation]) } : null;
    },
    nodeEnabled: nodeId => lanAgentAuthority.isNodeEnabled(nodeId),
    currentRelease: nodeId => lanAgentReleaseStore.publication(nodeId)
  });
  const peerAgentOptions: Parameters<typeof createPeerAgentEndpointBridge>[0] = {
    managerInstanceId: lanAgentRegistry.localInstanceId,
    localDeviceId: () => rabiLinkRelayConfigForMeta().deviceId,
    scope: () => rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()),
    request: requestPeerManagerApi,
    requestResult: requestPeerManagerResult,
    store: agentRequests,
    receiptDirectory: path.join(rootDir, "data", ".runtime", "peer-endpoint-transport-receipts"),
    readLocal: (provider, sessionId) => readAgentEndpointSummary(provider, sessionId, agentThreadRequestOptions({ agentAdapter: provider, threadId: sessionId })),
    localOptions: request => agentThreadRequestOptions(request),
    principal: request => rabiLinkAgentDevicePrincipal(request, rabiLinkRelayConfigForMeta(), managerHostIdentity?.applicationGenerationId ?? managerInstanceId) ?? undefined
  };
  const peerAgentBridge = createPeerAgentEndpointBridge(peerAgentOptions);
  instanceThreadTransport = {
    instances: () => lanAgentRegistry.listInstances(),
    manage: (instanceId, params, assertAuthorized) => lanAgentRegistry.manageAgent(instanceId, "threads", params, 30_000, assertAuthorized),
    peer: (binding, request) => peerAgentBridge.routeThread(binding, request)
  };
  agentEndpointDelivery = createAgentEndpointDelivery({ store: agentRequests, authority: lanAgentAuthority,
    registry: lanAgentRegistry, config: rabiGlobalConfig,
    peer: peerAgentBridge,
    service: createPublishedAgentServiceEndpointBridge(() => managerPluginKernel?.current()),
    device: createPublishedAgentDeviceEndpointBridge(() => managerPluginKernel?.current()),
    receiptDirectory: path.join(rootDir, "data", ".runtime", "endpoint-transport-receipts"),
    readLocal: readAgentEndpointSummary, localOptions: request => agentThreadRequestOptions(request) });
  const endpointRecovery = agentEndpointDelivery.recovery;
  // Preserve the original ledger; only explicit same-ID reconciliation initiates recovery.
  managerRuntimeOwner.register("lan_agent_registry", async () => {
    const recoveryStopped = endpointRecovery.stop();
    rabiLinkBusinessOwners = undefined;
    agentEndpointDelivery = undefined;
    instanceThreadTransport = undefined;
    lanAgentRegistry.close();
    await recoveryStopped;
  });
  managerRuntimeOwner.register("local_computer", async () => {
    applyComputerPresentationTheme = async () => {};
    await Promise.allSettled([...computerThemePending]);
    await lanAgentRegistry.stopLocalComputer();
  });
  managerRuntimeOwner.register("computer_source_lifecycle",()=>lanAgentRegistry.stopComputerSourceLifecycle());
  const computerPlanLog = managerOperationalLog.bind("computer.control", "warn");
  const computerPlanPending = new Set<Promise<unknown>>();
  const stopComputerPlanLifecycle = subscribeKnowledgeChanges((_roleDir, change) => {
    if (change.kind !== "plan") return;
    const pending = endComputerTrackingForPlan(change.item, lanAgentRegistry, rabiLinkRelayConfigForMeta().deviceId,
      (instanceId, error) => computerPlanLog.record("computer_plan_cleanup_unconfirmed", {instanceId,error}, state => ({target:{type:"computer",id:state.instanceId},error:managerOperationalError(state.error,packageRoot)})))
      .catch(error => computerPlanLog.record("computer_plan_lifecycle_failed", error, value => ({error:managerOperationalError(value,packageRoot)})));
    computerPlanPending.add(pending);
    void pending.then(() => computerPlanPending.delete(pending), () => computerPlanPending.delete(pending));
  });
  managerRuntimeOwner.register("computer_plan_lifecycle", async () => {
    stopComputerPlanLifecycle();
    await Promise.allSettled([...computerPlanPending]);
  });

  const webPluginModules = new WebPluginModuleRegistry();
  const messageEndpointScanProviders = new MessageAdapterScanProviderRegistry();
  const managerCorePublicOperations = () => createCorePublicOperations({
        identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
        metaPayload: () => measureSyncPerformanceOperation(PERFORMANCE_OPERATIONS.managerMetaBuild, metaPayload),
        health: managerHealthPayload,
        automaticUpdates: () => automaticCodeService?.snapshot() ?? { state: "disabled", reason: "No external source root is configured." },
        sourcePatches: managerSourcePatches,
        webPatches: managerWebPatches,
        deliveryAuthority: {
          store: agentRequests,
          managerInstanceId: lanAgentRegistry.localInstanceId,
          refreshEndpoints: async identities => {
            if (!agentEndpointDelivery) throw new Error("Manager endpoint delivery authority is unavailable.");
            await agentEndpointDelivery.refreshEndpoints(identities);
          },
          authorize: (endpoint, role) => {
            if (!agentEndpointDelivery) throw new Error("Manager endpoint delivery authority is unavailable.");
            agentEndpointDelivery.authorize(endpoint, role);
          }
        },
        identityReset: { service: instanceIdentityReset, currentGuid: () => rabiGlobalConfig.read().rabiGuid }
      });
  const agentScanPool = new AgentAdapterCatalogWorkerPool();
  agentManagerScanWorkers = agentScanPool;
  let agentScanDisposal: Promise<void> | undefined;
  stopAgentScanWorkers = () => agentScanDisposal ??= agentScanPool.stop("Manager is stopping.");
  managerRuntimeOwner.register("agent_provider_scan_workers", () => stopAgentScanWorkers!());
  let releaseAgentMetadataProjection: (() => void) | undefined;
  managerRuntimeOwner.register("agent_adapter_metadata_projection", () => {
    releaseAgentMetadataProjection?.();
    releaseAgentMetadataProjection = undefined;
  });
  const nativePluginHostPorts = await createMessageEndpointHostPorts();
  const managerFeatureHostPorts = createAgentAdapterHostPorts();
  const managerPluginHostServices: readonly HostService[] = Object.freeze([
    Object.freeze({ capability: "host.peer-transports@1", value: Object.freeze({
      priority: PEER_TRANSPORT_PRIORITY,
      createRtc: () => new TunnelRtc(),
      createWebSocketServer: (options: Readonly<{ maxPayload: number }>) => new WebSocketServer({ noServer: true, maxPayload: options.maxPayload }),
      websocketChannel, connectWebsocket
    }) }),
    Object.freeze({ capability: "host.agent-adapters@1", value: createAgentAdapterHostPorts({
      manager: Object.freeze({
        rootDir,
        packageRoot,
        readOnly: () => managerReadOnly,
        getRuntimes: () => runtimes.values(),
        publishManagerEvent,
        deviceContext: () => deviceAgentHostContext(lanAgentRegistry.localInstanceId),
        managerInstanceId: () => lanAgentRegistry.localInstanceId,
        runScan: (task: AgentAdapterCatalogWorkerTask, invocation?: AgentAdapterInvocation) =>
          agentScanPool.query(task, { signal: invocation?.signal }),
        registerOperations: (instanceId: string, definitions: readonly ApiOperationDefinition[], signal: AbortSignal) =>
          managerPluginRoutes.registerOperationsAsync(instanceId, definitions, signal)
      })
    }) }),
    Object.freeze({ capability: "host.message-endpoints@1", value: Object.freeze({
      manager: Object.freeze({
        roleDirectory: roleDirForApi,
        activity: allDayRecording.service.homeAssistantActivity,
        access: webguiLanRequestAllowed,
        lifecycleFence: Object.freeze({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
        routes: managerPluginRoutes,
        rootDir, managerPort, readOnly: managerReadOnly, checkHttpEndpoint,
        readRuntimes: () => [...runtimes.values()].map(runtime => ({ definition: structuredClone(runtime.definition), running: Boolean(runtime.process), status: structuredClone(readGatewayStatus(runtime.definition)) })),
        appendRouteLog: (id: string, line: string) => { const runtime = runtimes.get(id); if (runtime) appendLog(runtime, line); },
        readGatewayStatus, normalizeDefinition,
        readRoute: (routeId: string) => runtimes.get(routeId)?.definition,
        routeRunning: (routeId: string) => Boolean(runtimes.get(routeId)?.process && runtimes.get(routeId)?.readiness === "ready"),
        routeStartedAt: (routeId: string) => runtimes.get(routeId)?.startedAt ?? undefined,
        requestIsLoopback: (request: http.IncomingMessage) => isLoopbackRemoteAddress(request.socket.remoteAddress),
        jsonResponse,
        readRoutes: () => structuredClone(readConfig().gateways),
        writeRoutes: (routes: GatewayDefinition[], revision: string, operationId: string) => writeConfig({gateways: routes}, revision, operationId),
        saveRoute: writeAdapterConfigFile,
        routeVersion: () => routeCatalogVersion().routeConfigHash,
        syncRoutes: syncRunningGateways, gatewayPayload: standaloneGatewayPayload,
        log: (event: string, detail: string) => managerOperationalLog.record("info", event, { result: detail }),
        shouldAutostart: managerShouldAutostart,
        get ready() { return managerListenerReady && routeCatalogStartupLifecycle.snapshot().state === "ready"; },
        speechPorts: Object.freeze({
          rootDir, packageRoot, control: managerSpeechControlPorts,
          peerRuntime: () => activePeerTunnel, computeTarget: () => speechComputeTarget.getStore(),
          currentService: resolvePublishedPluginService,
          modelChanged: snapshot => publishManagerEvent("speech_model_management_changed", { activeJob: snapshot.activeJob, lastJob: snapshot.lastJob }),
          reportError: (reason, error) => console.warn(`Speech reconciliation failed after ${reason}:`, error instanceof Error ? error.message : String(error)),
          api: Object.freeze({
        readOnly: () => managerReadOnly,
        identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
        readProxyJson: readJsonBody,
        hostSpeechCommand: body => {
          const host = rabiGlobalConfig.read();
          return hostOwnedSpeechMessageCommand(body, { rabiGuid: host.rabiGuid, rabiName: host.rabiName, fallbackHostName: os.hostname() });
        },
        capture: (request, computeDeviceId) => {
          const peer = activePeerTunnel, selected = peer?.selected() || "";
          const generation = managerHostIdentity?.applicationGenerationId ?? managerInstanceId, instance = managerInstanceId;
          const guard = stickySpeechAuthority(() => {
            assertTrustedLanAgentPrincipal(request);
            if (activePeerTunnel !== peer || (peer?.selected() || "") !== selected
              || (managerHostIdentity?.applicationGenerationId ?? managerInstanceId) !== generation || managerInstanceId !== instance) {
              throw new SpeechControlError("Original speech owner changed; inspect the original operation before retrying.", 409);
            }
          });
          guard();
          if (computeDeviceId !== undefined && computeDeviceId.length > 200) throw new SpeechControlError("模型服务电脑编号无效。", 400);
          const targetLocal = rabiLinkTrustedTransport(request, generation, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()));
          return { guard, targetLocal, ...(peer && selected ? { selectedPeer: { runtime: peer, deviceId: selected } } : {}),
            run: operation => speechComputeTarget.run(computeDeviceId ?? selected, operation) };
        }

          })
        } satisfies SpeechPluginPorts),
        speechLifecycle: Object.freeze({ managerPluginRoutes, managerReadOnly,
          get managerServicesReady() { return managerServicesReady; }
        })
      }),
      ...nativePluginHostPorts,
      gatewayExecution: Object.freeze({
        rootDir,
        routeSnapshots: () => [...runtimes.values()].map(runtime => ({ definition: structuredClone(runtime.definition) })),
        childCommand,
        environmentForGateway: envFor,
        appendLog: (gatewayId: string, message: string) => { const runtime = runtimes.get(gatewayId); if (runtime) appendLog(runtime, message); }
      }),
      scanProviders: messageEndpointScanProviders,
      managers: messageEndpointManagers,
      operations: managerPluginRoutes,

      routeSnapshots: (type: string) => adapterRuntimes(type).map(runtime => ({
        definition: structuredClone(runtime.definition), status: structuredClone(readGatewayStatus(runtime.definition)),
        callback: routeCallbackEndpoint(runtime, type), hasRecentMessages: routeHasRecentMessages(runtime, type)
      }))
    }) }),
    Object.freeze({ capability: "host.manager.operations@1", value: createManagerApiOperationsService(managerPluginRoutes) }),
    Object.freeze({ capability: "host.manager.video@2", value: Object.freeze({ ...managerFeatureHostPorts, get rootDir() { return rootDir; },
get managerPluginProcessLeases() { return managerPluginProcessLeases; },
get managerReadOnly() { return managerReadOnly; },
get activePeerTunnel() { return activePeerTunnel; },
set activePeerTunnel(value) { activePeerTunnel = value; } }) }),
    Object.freeze({
      capability: "host.manager.wearable-companion-runtime@1",
      value: Object.freeze({ ...managerFeatureHostPorts, input: Object.freeze({
    hostOwned: Boolean(managerHostIdentity),
    managerBaseUrl,
    applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    managerInstanceId,
    runtimeRoot: rootDir,
    explicitPwshPath: process.env.RABIROUTE_PWSH_PATH,
    environment: process.env
  }) })
    }),
    Object.freeze({
      capability: "host.manager.wearable-companion@2",
      value: Object.freeze({ leases: managerPluginProcessLeases, startupReady: wearableCompanionStartupReady })
    }),
    Object.freeze({ capability: "host.manager.http@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      jsonResponse,
      publishManagerEvent,
      readJsonBody,
      registerRoutes(instanceId: string, handlerId: string, handlers: Parameters<typeof registerManagerPluginHandlerRoutes>[3], declarations: Parameters<typeof registerManagerPluginHandlerRoutes>[4]) {
        return registerManagerPluginHandlerRoutes(managerPluginRoutes, instanceId, handlerId, handlers, declarations);
      }
    }) }),
    createSourcePatchHostService(() => managerSourcePatches),
    Object.freeze({ capability: "host.manager.computer-settings-definition@1", value: Object.freeze({createComputerSettingsDefinition}) }),
    Object.freeze({ capability: "host.manager.core@2", value: Object.freeze({ createComputerSettingsDefinition, ...managerFeatureHostPorts, get managerCorePublicOperations() { return managerCorePublicOperations; }, get ManagerPluginRequestTracker() { return ManagerPluginRequestTracker; },
get lanAgentRegistry() { return lanAgentRegistry; },
get rabiGlobalConfig() { return rabiGlobalConfig; },
get lanAgentAuthority() { return lanAgentAuthority; },
get packageRoot() { return packageRoot; },
get managerHostIdentity() { return managerHostIdentity; },
get managerInstanceId() { return managerInstanceId; },
set managerInstanceId(value) { managerInstanceId = value; },
get managerHealthPayload() { return managerHealthPayload; },
get publicWebguiLanAccessPayload() { return publicWebguiLanAccessPayload; },
get generateWebguiAccessToken() { return generateWebguiAccessToken; },
get hasAuthenticatedConnectionRequest() { return hasAuthenticatedConnectionRequest; },
get isLocalMachineRemoteAddress() { return isLocalMachineRemoteAddress; },
get localIpv4AddressEntries() { return localIpv4AddressEntries; },
get resourceCache() { return resourceCache; },
get resourceCacheOptions() { return resourceCacheOptions; },
get recordingArchiveRuntime() { return recordingArchiveRuntime; },
get recordingArchiveAdminOptions() { return recordingArchiveAdminOptions; },
get webuiDistPath() { return webuiDistPath; },
get managerWebPatches() { return managerWebPatches; },
get isManagerControlRequestPath() { return isManagerControlRequestPath; },
get splitManagerBootstrapPublicOperations() { return splitManagerBootstrapPublicOperations; },
get managerPluginKernel() { return managerPluginKernel; },
set managerPluginKernel(value) { managerPluginKernel = value; },
get managerSourcePatches() { return managerSourcePatches; },
get managerPluginDiagnostics() { return managerPluginDiagnostics; },
set managerPluginDiagnostics(value) { managerPluginDiagnostics = value; },
get managerPluginGenerationStatus() { return managerPluginGenerationStatus; },
set managerPluginGenerationStatus(value) { managerPluginGenerationStatus = value; },
get reconcileManagerPlugins() { return reconcileManagerPlugins; },
get webPluginModules() { return webPluginModules; },
get managerReadOnly() { return managerReadOnly; },
get createManagerEventOperationDefinition() { return createManagerEventOperationDefinition; },
get jsonResponse() { return jsonResponse; },
get lanAgentReleaseStore() { return lanAgentReleaseStore; },
get routeCatalogConfig() { return routeCatalogConfig; },
set routeCatalogConfig(value) { routeCatalogConfig = value; },
get configuredAgentProviderTypes() { return configuredAgentProviderTypes; },
get invokePublishedAgentOperation() { return invokePublishedAgentOperation; },
get writeGatewayConfig() { return writeGatewayConfig; },
get randomUUID() { return randomUUID; },
get syncRunningGateways() { return syncRunningGateways; },
get configuredLocalAgentSessionFields() { return configuredLocalAgentSessionFields; },
get rootDir() { return rootDir; },
get manageInstanceAgent() { return manageInstanceAgent; },
get resolvePublishedAgentManagerProviders() { return resolvePublishedAgentManagerProviders; },
get routeCatalogVersion() { return routeCatalogVersion; },
get managerPluginRoutes() { return managerPluginRoutes; },
get readJsonBody() { return readJsonBody; },
get registerManagerPluginHandlerRoutes() { return registerManagerPluginHandlerRoutes; },
get webguiTokenMatches() { return webguiTokenMatches; },
get measureSyncPerformanceOperation() { return measureSyncPerformanceOperation; },
get PERFORMANCE_OPERATIONS() { return PERFORMANCE_OPERATIONS; },
get metaPayload() { return metaPayload; },
get automaticCodeService() { return automaticCodeService; },
get agentRequests() { return agentRequests; },
get agentEndpointDelivery() { return agentEndpointDelivery; },
set agentEndpointDelivery(value) { agentEndpointDelivery = value; },
get instanceIdentityReset() { return instanceIdentityReset; } }) }),
    Object.freeze({ capability: "host.manager.desktop-native@1", value: Object.freeze({
      status: () => lanAgentRegistry.localComputer!.desktopReleaseStatus(),
      prepare: (releaseDigest: string) => lanAgentRegistry.localComputer!.prepareDesktopRelease(releaseDigest),
      activate: (prepared: unknown, expectedRevision: number) => lanAgentRegistry.localComputer!.activateDesktopRelease(prepared, expectedRevision),
      discard: (prepared: unknown) => lanAgentRegistry.localComputer!.discardDesktopRelease(prepared)
    }) }),
    Object.freeze({ capability: "host.manager.persona@2", value: Object.freeze({ ...managerFeatureHostPorts, get ManagerPluginRequestTracker() { return ManagerPluginRequestTracker; },
get rolesRoot() { return managerRolesRoot(); },
set rolesRoot(value) { configRepository.rolesRoot = value; },
get managerHostIdentity() { return managerHostIdentity; },
get managerInstanceId() { return managerInstanceId; },
set managerInstanceId(value) { managerInstanceId = value; },
get readConfig() { return readConfig; },
get managerReadOnly() { return managerReadOnly; },
get routeCatalogPersonas() { return routeCatalogPersonas; },
get path() { return path; },
get requireRouteCatalogLifecycle() { return requireRouteCatalogLifecycle; },
get RoleLifecycleError() { return RoleLifecycleError; },
get ensureDataDirs() { return ensureDataDirs; },
get publishManagerEvent() { return publishManagerEvent; },
get roleDirForApi() { return roleDirForApi; },
get languageStyleValidator() { return languageStyleValidator; },
get handleAgentThreadRequest() { return handleAgentThreadRequest; },
get agentThreadRequestOptions() { return agentThreadRequestOptions; },
get subscribeRoleCatalogChanges() { return (listener: () => void) => requireRouteCatalogLifecycle().onReady(() => listener()); },
get routeCatalogConfig() { return routeCatalogConfig; },
set routeCatalogConfig(value) { routeCatalogConfig = value; },
get sharedGatewayAdapterTypes() { return sharedGatewayAdapterTypes; },
get sharedNormalizeNapCatInstances() { return sharedNormalizeNapCatInstances; },
get readChatDeliveryParties() { return readChatDeliveryParties; },
get agentRequests() { return agentRequests; },
get lanAgentRegistry() { return lanAgentRegistry; },
get queryMessageHistory() { return queryMessageHistory; },
get createPersonaStorageOperationsContext() { return createPersonaStorageOperationsContext; },
get allDayRecording() { return allDayRecording; },
get isLocalMachineRemoteAddress() { return isLocalMachineRemoteAddress; },
get companionActivityContext() { return companionActivityContext; },
get managerPort() { return managerPort; },
set managerPort(value) { managerPort = value; },
get deliverWearableAlert() { return deliverWearableAlert; },
get knowledgeSearchService() { return knowledgeSearchService; },
set knowledgeSearchService(value) { knowledgeSearchService = value; },
get requestRoleKnowledgeCatalogRefresh() { return requestRoleKnowledgeCatalogRefresh; },
get managerKnowledgePageWorkerPool() { return managerKnowledgePageWorkerPool; },
get appendRolePanelTimeline() { return appendRolePanelTimeline; },
get currentRoleStorageApplication() { return currentRoleStorageApplication; },
get rootDir() { return rootDir; },
get runtimes() { return runtimes; },
get currentPersonaMessageAuthority() { return currentPersonaMessageAuthority; },
get triggerGatewayRolePanelMessage() { return triggerGatewayRolePanelMessage; },
get roleIdForDefinition() { return roleIdForDefinition; },
get assertLocalPersonaOwner() { return assertLocalPersonaOwner; },
get managerReadWorkerPool() { return managerReadWorkerPool; },
get managerPluginRoutes() { return managerPluginRoutes; },
get registerManagerPluginHandlerRoutes() { return registerManagerPluginHandlerRoutes; } }) }),
    Object.freeze({ capability: "host.manager.performance@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; },
get managerReadOnly() { return managerReadOnly; },
get performanceMonitoring() { return performanceMonitoring; },
get rabiGlobalConfig() { return rabiGlobalConfig; },
get runtimes() { return runtimes; },
get recordManagerHttpRequest() { return recordManagerHttpRequest; },
set recordManagerHttpRequest(value) { recordManagerHttpRequest = value; } }) }),
    Object.freeze({ capability: "host.manager.bilibili-history@2", value: Object.freeze({ ...managerFeatureHostPorts, get configRepository() { return configRepository; },
get managerPluginRoutes() { return managerPluginRoutes; },
get managerReadOnly() { return managerReadOnly; },
get path() { return path; },
get rootDir() { return rootDir; } }) }),
    Object.freeze({ capability: "host.manager.route-control@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; },
get rootDir() { return rootDir; },
get routeRoot() { return managerRouteRoot(); },
set routeRoot(value) { configRepository.routeRoot = value; },
get managerPort() { return managerPort; },
set managerPort(value) { managerPort = value; },
get managerHost() { return managerHost; },
get managerHostIdentity() { return managerHostIdentity; },
get managerInstanceId() { return managerInstanceId; },
set managerInstanceId(value) { managerInstanceId = value; },
get rabiRoutePackageVersion() { return rabiRoutePackageVersion; },
get rabiGlobalConfig() { return rabiGlobalConfig; },
get runtimes() { return runtimes; },
get runtimeStatus() { return runtimeStatus; },
get readConfig() { return readConfig; },
get writeConfig() { return writeConfig; },
get loadRuntimes() { return loadRuntimes; },
get routeCatalogVersion() { return routeCatalogVersion; },
get routeCatalogPersonas() { return routeCatalogPersonas; },
get syncRunningGateways() { return syncRunningGateways; },
get syncActiveRabiLinkRelay() { return syncActiveRabiLinkRelay; },
set syncActiveRabiLinkRelay(value) { syncActiveRabiLinkRelay = value; },
get dataDirFor() { return dataDirFor; },
get agentAdapterCatalogService() { return agentAdapterCatalogService; },
set agentAdapterCatalogService(value) { agentAdapterCatalogService = value; },
get rolesRoot() { return managerRolesRoot(); },
set rolesRoot(value) { configRepository.rolesRoot = value; },
get readManagerConfig() { return readManagerConfig; },
get writeManagerConfig() { return writeManagerConfig; },
get ensureDataDirs() { return ensureDataDirs; } }) }),
    Object.freeze({ capability: "host.manager.agent-state-control@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; },
get runtimes() { return runtimes; },
get agentStateByGateway() { return agentStateByGateway; },
get writeAdapterConfigFile() { return writeAdapterConfigFile; },
get publishManagerEvent() { return publishManagerEvent; } }) }),
    Object.freeze({ capability: "host.manager.gateway-runtime@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; },
get managerReadOnly() { return managerReadOnly; },
get manualTriggerProcesses() { return manualTriggerProcesses; },
get stopAllGatewaysAndWait() { return stopAllGatewaysAndWait; },
get syncRunningGateways() { return syncRunningGateways; },
get gatewayRuntimePluginLease() { return gatewayRuntimePluginLease; },
get listenerPublicationHost() { return listenerPublicationHost; },
get managerServicesReady() { return managerServicesReady; },
set managerServicesReady(value) { managerServicesReady = value; },
get standaloneGatewayPayload() { return standaloneGatewayPayload; },
get writeConfig() { return writeConfig; },
get writeGatewayConfig() { return writeGatewayConfig; },
get resolveRouteMutation() { return resolveRouteMutation; },
get loadRuntimes() { return loadRuntimes; },
get routeMutationActivation() { return routeMutationActivation; },
get runtimes() { return runtimes; },
get runtimeStatus() { return runtimeStatus; },
get networkOptionsPayload() { return networkOptionsPayload; },
get startGateway() { return startGateway; },
get stopGateway() { return stopGateway; },
get restartGateway() { return restartGateway; },
get removeGatewayConfig() { return removeGatewayConfig; },
get routeCatalogVersion() { return routeCatalogVersion; },
get sharedGatewayAdapterTypes() { return sharedGatewayAdapterTypes; },
get dataDirFor() { return dataDirFor; },
get requestWeixinLogin() { return requestWeixinLogin; },
get triggerGatewayManualRule() { return triggerGatewayManualRule; },
get testGatewayAgentDelivery() { return testGatewayAgentDelivery; },
get listGatewayDeliveryReplayAttempts() { return listGatewayDeliveryReplayAttempts; },
get replayGatewayDelivery() { return replayGatewayDelivery; } }) }),
    Object.freeze({ capability: "host.manager.rabilink-relay@2", value: Object.freeze({ ...managerFeatureHostPorts, get rabiLinkRelayConfigForMeta() { return rabiLinkRelayConfigForMeta; },
get rabiGlobalConfig() { return rabiGlobalConfig; },
get rabiLinkConnectionScope() { return rabiLinkConnectionScope; },
get managerHostIdentity() { return managerHostIdentity; },
get managerInstanceId() { return managerInstanceId; },
set managerInstanceId(value) { managerInstanceId = value; },
get rabiLinkAgentDevicePrincipal() { return rabiLinkAgentDevicePrincipal; },
get rabiLinkDeviceConnections() { return rabiLinkDeviceConnections; },
get discoverRabiPeers() { return discoverRabiPeers; },
get peerRelayConfig() { return peerRelayConfig; },
get lanAgentAuthority() { return lanAgentAuthority; },
get managerPluginRoutes() { return managerPluginRoutes; },
get path() { return path; },
get rootDir() { return rootDir; },
get managerReadOnly() { return managerReadOnly; },
get currentRabiLinkBusinessOwners() { return currentRabiLinkBusinessOwners; },
get peerLanServer() { return peerLanServer; },
get rabiLinkRelayRuntime() { return rabiLinkRelayRuntime; },
get syncRabiLinkRelayRuntime() { return syncRabiLinkRelayRuntime; },
get managerListenerReady() { return managerListenerReady; },
set managerListenerReady(value) { managerListenerReady = value; },
get syncActiveRabiLinkRelay() { return syncActiveRabiLinkRelay; },
set syncActiveRabiLinkRelay(value) { syncActiveRabiLinkRelay = value; },
get currentPluginActivation() { return currentPluginActivation; },
get prepareManagerPeerRuntime() { return prepareManagerPeerRuntime; },
get readJsonBody() { return readJsonBody; },
get jsonResponse() { return jsonResponse; },
get publishManagerEvent() { return publishManagerEvent; },
get managerPort() { return managerPort; },
set managerPort(value) { managerPort = value; },
get hasAuthenticatedConnectionRequest() { return hasAuthenticatedConnectionRequest; },
get webguiLanRequestAllowed() { return webguiLanRequestAllowed; },
get managerBaseUrl() { return managerBaseUrl; },
set managerBaseUrl(value) { managerBaseUrl = value; },
get speechServiceUrl() { return speechServiceUrl; },
get resourceCacheKey() { return resourceCacheKey; },
get createManagerApiOperationsService() { return createManagerApiOperationsService; },
get activePeerTunnel() { return activePeerTunnel; },
set activePeerTunnel(value) { activePeerTunnel = value; },
get activePeerRuntime() { return activePeerRuntime; },
set activePeerRuntime(value) { activePeerRuntime = value; },
get admitPeerProxyUpgrade() { return admitPeerProxyUpgrade; } }) }),
    Object.freeze({ capability: "host.manager.memory-consolidation@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerReadOnly() { return managerReadOnly; },
get manualTriggerProcesses() { return manualTriggerProcesses; },
get managerListenerReady() { return managerListenerReady; },
set managerListenerReady(value) { managerListenerReady = value; },
get memoryConsolidationScheduler() { return memoryConsolidationScheduler; },
set memoryConsolidationScheduler(value) { memoryConsolidationScheduler = value; },
get path() { return path; },
get projectDirectoryLayout() { return projectDirectoryLayout; },
get rootDir() { return rootDir; },
get memoryConsolidationScheduleTargets() { return memoryConsolidationScheduleTargets; },
get evaluateMemoryConsolidationSchedule() { return evaluateMemoryConsolidationSchedule; },
get getTimeoutMs() { return getTimeoutMs; },
get currentRoleStorageApplication() { return currentRoleStorageApplication; },
get roleStorageOperationKey() { return roleStorageOperationKey; },
get deliverAutomaticMemoryConsolidation() { return deliverAutomaticMemoryConsolidation; },
get managerOperationalLog() { return managerOperationalLog; },
get managerOperationalError() { return managerOperationalError; },
get runtimes() { return runtimes; },
get memoryConsolidationFailureDiagnostic() { return memoryConsolidationFailureDiagnostic; },
get appendLog() { return appendLog; } }) }),
    Object.freeze({ capability: "host.manager.message-processing-control@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; },
get messageProcessingBoardPayload() { return messageProcessingBoardPayload; },
get messageProcessingBoard() { return messageProcessingBoard; },
get messageProcessingSendContextReview() { return messageProcessingSendContextReview; },
get managerOperationalLog() { return managerOperationalLog; },
get recalledKnowledgeForMessage() { return recalledKnowledgeForMessage; },
get verifyCriticalProjectFactRecord() { return verifyCriticalProjectFactRecord; },
get rootDir() { return rootDir; },
get roleDirForApi() { return roleDirForApi; },
get setMessageProcessingPlanBaseline() { return setMessageProcessingPlanBaseline; },
get scheduleKnowledgeCallbackReminder() { return scheduleKnowledgeCallbackReminder; },
get publishManagerEvent() { return publishManagerEvent; } }) }),
    Object.freeze({ capability: "host.manager.message-processing-automation@2", value: Object.freeze({ ...managerFeatureHostPorts,
get deliverKnowledgeCallbackReminder() { return deliverKnowledgeCallbackReminder; },
get handleMessageProcessingPlanUpdate() { return handleMessageProcessingPlanUpdate; },
get managerOperationalError() { return managerOperationalError; },
get managerOperationalLog() { return managerOperationalLog; },
get managerReadOnly() { return managerReadOnly; },
get messageProcessingBoard() { return messageProcessingBoard; },
get rootDir() { return rootDir; },
get subscribePlanUpdates() { return subscribePlanUpdates; },
get knowledgeCallbackReminderService() { return knowledgeCallbackReminderService; },
set knowledgeCallbackReminderService(value) { knowledgeCallbackReminderService = value; },
}) }),
    Object.freeze({ capability: "host.manager.plan-feedback-delivery@2", value: Object.freeze({ ...managerFeatureHostPorts, get ManagerReadWorkerError() { return ManagerReadWorkerError; },
get activePlanFeedbackDeliveryFlights() { return activePlanFeedbackDeliveryFlights; },
get inspectPlanFeedbackDelivery() { return inspectPlanFeedbackDelivery; },
get managerOperationalError() { return managerOperationalError; },
get managerOperationalLog() { return managerOperationalLog; },
get managerReadOnly() { return managerReadOnly; },
get managerReadWorkerPool() { return managerReadWorkerPool; },
get path() { return path; },
get projectDirectoryLayout() { return projectDirectoryLayout; },
get rootDir() { return rootDir; },
get publishManagerEvent() { return publishManagerEvent; },
get recoverPlanFeedbackCandidate() { return recoverPlanFeedbackCandidate; },
get scheduleAndWaitForPlanFeedbackDelivery() { return scheduleAndWaitForPlanFeedbackDelivery; },
get managerListenerReady() { return managerListenerReady; },
set managerListenerReady(value) { managerListenerReady = value; },
get planFeedbackDeliveryActive() { return planFeedbackDeliveryActive; },
set planFeedbackDeliveryActive(value) { planFeedbackDeliveryActive = value; },
get planFeedbackRecoveryService() { return planFeedbackRecoveryService; },
set planFeedbackRecoveryService(value) { planFeedbackRecoveryService = value; },
get rolesRoot() { return managerRolesRoot(); },
set rolesRoot(value) { configRepository.rolesRoot = value; },
get startActivePlanFeedbackRecovery() { return startActivePlanFeedbackRecovery; },
set startActivePlanFeedbackRecovery(value) { startActivePlanFeedbackRecovery = value; } }) }),
    Object.freeze({ capability: "host.manager.message-adapter-control@2", value: Object.freeze({ ...managerFeatureHostPorts, get messageEndpointScanProviders() { return messageEndpointScanProviders; },
get adapterRuntimes() { return adapterRuntimes; },
get checkHttpEndpoint() { return checkHttpEndpoint; },
get managerPluginRoutes() { return managerPluginRoutes; },
get messageEndpointManagers() { return messageEndpointManagers; },
get readGatewayStatus() { return readGatewayStatus; },
get remoteAgentMessageAdapterScanResult() { return remoteAgentMessageAdapterScanResult; },
get rootDir() { return rootDir; },
get routeCallbackEndpoint() { return routeCallbackEndpoint; },
get routeHasRecentMessages() { return routeHasRecentMessages; },
get speechControl() { return speechControl; },
get standaloneGatewayPayload() { return standaloneGatewayPayload; } }) }),
    Object.freeze({ capability: "host.manager.agent-adapter-catalog@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; },
get managerPluginKernel() { return managerPluginKernel; },
set managerPluginKernel(value) { managerPluginKernel = value; },
get rootDir() { return rootDir; },
get runtimes() { return runtimes; },
get agentAdapterCatalogService() { return agentAdapterCatalogService; },
set agentAdapterCatalogService(value) { agentAdapterCatalogService = value; } }) }),
    Object.freeze({ capability: "host.manager.agent-communication@2", value: Object.freeze({ ...managerFeatureHostPorts, get agentRequests() { return agentRequests; },
get agentEndpointDelivery() { return agentEndpointDelivery; },
set agentEndpointDelivery(value) { agentEndpointDelivery = value; },
get lanAgentRegistry() { return lanAgentRegistry; },
get getTimeoutMs() { return getTimeoutMs; },
get agentSendReceiptResponse() { return agentSendReceiptResponse; },
get maintainAgentSendReceipt() { return maintainAgentSendReceipt; },
get codexHookContextService() { return codexHookContextService; },
get readAgentChatHistory() { return readAgentChatHistory; },
get assertTrustedLanAgentPrincipal() { return assertTrustedLanAgentPrincipal; },
get hasAuthenticatedConnectionRequest() { return hasAuthenticatedConnectionRequest; },
get webguiLanRequestAllowed() { return webguiLanRequestAllowed; },
get managerBaseUrl() { return managerBaseUrl; },
set managerBaseUrl(value) { managerBaseUrl = value; },
get agentUploadStore() { return agentUploadStore; },
get assertUploadAuthorized() { return assertUploadAuthorized; },
get findAgentSendTraces() { return findAgentSendTraces; },
get jsonResponse() { return jsonResponse; },
get managerPluginRoutes() { return managerPluginRoutes; },
get runtimes() { return runtimes; },
get readGatewayStatus() { return readGatewayStatus; },
get isLoopbackRemoteAddress() { return isLoopbackRemoteAddress; },
get performAgentSend() { return performAgentSend; },
get publishManagerEvent() { return publishManagerEvent; },
get readJsonBody() { return readJsonBody; },
get rootDir() { return rootDir; } }) }),
    Object.freeze({ capability: "host.manager.agent-thread-control@2", value: Object.freeze({ ...managerFeatureHostPorts, get agentRequests() { return agentRequests; },
get agentThreadRequestFailureData() { return agentThreadRequestFailureData; },
get agentThreadRequestOptions() { return agentThreadRequestOptions; },
get getTrustedLanAgentSource() { return getTrustedLanAgentSource; },
get rabiLinkAgentTaskSource() { return rabiLinkAgentTaskSource; },
get rabiLinkRelayConfigForMeta() { return rabiLinkRelayConfigForMeta; },
get managerHostIdentity() { return managerHostIdentity; },
get managerInstanceId() { return managerInstanceId; },
set managerInstanceId(value) { managerInstanceId = value; },
get applyManagedAgentThreadDefaults() { return applyManagedAgentThreadDefaults; },
get peerAgentBridge() { return peerAgentBridge; },
get peerAgentOptions() { return peerAgentOptions; },
get path() { return path; },
get rootDir() { return rootDir; },
get agentEndpointDelivery() { return agentEndpointDelivery; },
set agentEndpointDelivery(value) { agentEndpointDelivery = value; },
get handleAgentThreadRequest() { return handleAgentThreadRequest; },
get managerOperationalError() { return managerOperationalError; },
get managerOperationalLog() { return managerOperationalLog; },
get managerPluginRoutes() { return managerPluginRoutes; },
get messageProcessingBoard() { return messageProcessingBoard; },
get publishManagerEvent() { return publishManagerEvent; },
get setMessageProcessingPlanBaseline() { return setMessageProcessingPlanBaseline; } }) }),
    Object.freeze({ capability: "host.manager.remote-agent@2", value: Object.freeze({ ...managerFeatureHostPorts, get ManagerPluginRequestTracker() { return ManagerPluginRequestTracker; },
get appendLog() { return appendLog; },
get appendMessageContextToDir() { return appendMessageContextToDir; },
get handleRemoteAgentTaskEvent() { return handleRemoteAgentTaskEvent; },
get jsonResponse() { return jsonResponse; },
get managerHost() { return managerHost; },
get managerPluginRoutes() { return managerPluginRoutes; },
get managerPort() { return managerPort; },
set managerPort(value) { managerPort = value; },
get path() { return path; },
get readJsonBody() { return readJsonBody; },
get registerManagerPluginHandlerRoutes() { return registerManagerPluginHandlerRoutes; },
get remoteAgentPublicHost() { return remoteAgentPublicHost; },
get remoteAgentTaskWithGatewayDefaults() { return remoteAgentTaskWithGatewayDefaults; },
get roleDirForDefinition() { return roleDirForDefinition; },
get rootDir() { return rootDir; },
get runtimes() { return runtimes; },
get remoteAgentHub() { return remoteAgentHub; },
set remoteAgentHub(value) { remoteAgentHub = value; } }) }),
    Object.freeze({ capability: "host.manager.gateway-status@1", value: Object.freeze({
      readStatuses: () => measureSyncPerformanceOperation(PERFORMANCE_OPERATIONS.managerGatewaysBuildDiagnostics, () => {
        return readGatewayDiagnosticsStatuses(rootDir, runtimes.keys().map(id => [id, runtimes.get(id)!] as const), activeGatewayDiagnosticsSnapshotService(), failure => {
          gatewayDiagnosticsReadLog.record("gateway_diagnostics_read_failed", failure, value => ({
            action: value.stage, routeId: value.gatewayId, owner: "gateway_diagnostics",
            error: managerOperationalError(value.error, rootDir)
          }));
        });
      }),
    }) }),
    Object.freeze({ capability: "host.manager.desktop@2", value: Object.freeze({ ...managerFeatureHostPorts, get adapterConfigPath() { return adapterConfigPath; },
get desktopSettings() { return desktopSettings; },
get managerReadOnly() { return managerReadOnly; },
get publishManagerEvent() { return publishDesktopSettingsEvent; },
get ensureDataDirs() { return ensureDataDirs; },
get ensurePersonaConfigFile() { return ensurePersonaConfigFile; },
get ensureRoleFile() { return ensureRoleFile; },
get ensureRoleFolder() { return ensureRoleFolder; },
get managerPluginRoutes() { return managerPluginRoutes; },
get rootDir() { return rootDir; },
get runtimes() { return runtimes; },
get writeAdapterConfigFile() { return writeAdapterConfigFile; },
get rolesRoot() { return managerRolesRoot(); },
set rolesRoot(value) { configRepository.rolesRoot = value; },
get routeRoot() { return managerRouteRoot(); },
set routeRoot(value) { configRepository.routeRoot = value; } }) }),
    Object.freeze({ capability: "host.manager.desktop-pet@2", value: Object.freeze({ ...managerFeatureHostPorts, get desktopSettings() { return desktopSettings; },
get managerPluginRoutes() { return managerPluginRoutes; },
get publishManagerEvent() { return publishManagerEvent; },
get roleDirForApi() { return roleDirForApi; } }) }),
    Object.freeze({ capability: "host.manager.yeyu-gamer@2", value: Object.freeze({ ...managerFeatureHostPorts, get managerPluginRoutes() { return managerPluginRoutes; } }) }),
  ]);
  const configuredPluginProfile = process.env.RABIROUTE_PLUGIN_PROFILE?.trim();
  const managerPluginProfilePath = configuredPluginProfile
    ? path.resolve(configuredPluginProfile)
    : path.join(packageRoot, "dist", "plugins", "profiles", "desktop.json");
  const managerPluginSettings = new PluginProfileSettings({
    profilePath: managerPluginProfilePath,
    settingsRoot: path.join(rootDir, "data", "plugins", "settings"),
    migrationsPath: path.join(packageRoot, "dist", "plugins", "profiles", "package-migrations.json"),
    onSlowFs: detail => {
      if (!managerOperationalLog.isEnabled("filesystem", "warn")) return;
      const diagnostic = JSON.stringify(detail);
      managerOperationalLog.record("warn", "filesystem_await_stalled", {
        group: "filesystem", owner: detail.owner, requestId: detail.requestId,
        durationMs: detail.operationElapsedMs, result: diagnostic
      });
      try { process.stderr.write("[RabiRoute filesystem await] " + diagnostic + "\n"); }
      catch { managerOperationalLog.record("warn", "filesystem_diagnostic_stderr_failed", { group: "filesystem", owner: detail.owner }); }
    }
  });
  const builtinPluginPackageRoot = path.join(packageRoot, "dist", "plugins", "packages");
  const managedPluginPackageRoot = path.join(rootDir, "data", "plugins", "packages");
  const managerPluginPackageRoots = resolvePluginPackageRoots({ packageRoot, stateRoot: rootDir });
  const managerPluginExecutionSettings = resolveInProcessRoots();
  const managerPluginPackageCatalog = new PluginPackageCatalog(managerPluginPackageRoots, {
    trustedInProcessRoots: managerPluginExecutionSettings.roots,
    configurationDiagnostics: managerPluginExecutionSettings.diagnostics
  });
  stopPluginPackagePreparation = () => managerPluginPackageCatalog.dispose();
  for (const diagnostic of managerPluginPackageCatalog.snapshot().configurationDiagnostics) {
    managerOperationalLog.record("warn", "plugin_execution_configuration_invalid", {
      action: diagnostic.field, result: diagnostic.message
    });
  }
  managerRuntimeOwner.register("plugin_package_catalog", () => managerPluginPackageCatalog.dispose());
  const startupPresentationProjector = createStartupPresentationProjector({ stateRoot: rootDir,
    resolvePackage: (pluginId, version) => managerPluginPackageCatalog.resolve(pluginId, version) });
  managerRuntimeOwner.register("startup_presentation_cache", () => startupPresentationProjector.stop());
  let startupPresentationRefreshQueued = false;
  refreshStartupPresentation = (): void => {
    if (shuttingDown || managerReadOnly || startupPresentationRefreshQueued) return;
    startupPresentationRefreshQueued = true;
    setImmediate(() => {
      startupPresentationRefreshQueued = false;
      if (shuttingDown) return;
      void startupPresentationProjector.refresh(async () => ({
        webTheme: desktopSettings.read().webTheme, profile: (await managerPluginSettings.snapshot()).profile
      })).then(result => {
        if (result.diagnostic) managerOperationalLog.record("warn", "startup_appearance_unavailable", { result: result.diagnostic });
      });
    });
  };
  const managerPluginOutcomeArchive = new AsyncPluginOutcomeArchive(path.join(rootDir, "data", ".runtime", "plugin-runtime", "unknown-outcomes"));
  managerRuntimeOwner.register("plugin_async_outcome_archive", () => managerPluginOutcomeArchive.dispose());
  try {
  managerPluginKernel = new GenerationRuntime({
    host: "manager",
    hostServices: [...managerPluginHostServices, Object.freeze({ capability: "host.message-endpoints@2",
      value: managerPluginHostServices.find(service => service.capability === "host.message-endpoints@1")!.value })],
    applicationIdentity: {
      applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
      managerInstanceId
    },
    executor: createFullPluginExecutor(managerPluginProcessLeases, managerPluginOutcomeArchive, capturePluginRuntimeObservation),
    onPublished: generation => {
      capturePluginGeneration(generation);
      managerPluginRoutes.refreshPublication();
      publishManagerEvent("plugin_catalog_changed", {
        reason: "plugin lifecycle publication", generation: generation.id,
        revision: { plugins: generation.sequence, contributions: generation.contributions.revision }
      });
    },
    onRuntimeFailure: event => {
      capturePluginGeneration(event.generation);
      if (managerServicesReady && !managerReadOnly) syncRunningGateways();
      const active = event.generation.records.filter(record => record.status === "active").map(record => record.identity.instanceId);
      const waiting = event.generation.records.filter(record => record.status === "waiting_dependency").map(record => record.identity.instanceId);
      const failed = event.generation.records.filter(record => record.status === "failed").map(record => record.identity.instanceId);
      managerOperationalLog.record("error", "plugin_runtime_failed", {
        result: `plugin=${event.identity.instanceId}; code=${event.error.code}`,
        error: managerOperationalError(event.error, rootDir)
      });
      publishManagerEvent("plugin_reconciliation_changed", {
        reason: "runtime failure",
        state: "runtime_failed",
        active,
        waiting,
        failed,
        diagnostics: managerPluginDiagnostics
      });
      publishManagerEvent("plugin_catalog_changed", {
        reason: "runtime failure",
        generation: event.generation.id,
        revision: {
          plugins: event.generation.sequence,
          contributions: event.generation.contributions.revision
        }
      });
    }
  });
  const releaseAgentGenerationReader = installAgentAdapterGenerationReader(() => managerPluginKernel?.current());
  managerRuntimeOwner.registerWithBudget("manager_plugin_kernel", async budget => {
    try { await managerPluginKernel?.shutdown({ timeoutMs: Math.max(1, Math.floor(budget.deadlineAt - performance.now())) }); }
    finally { releaseAgentGenerationReader(); }
  });
  } catch (error) {
    await failManagerStartup("manager_plugin_kernel_construction", error);
  }
  let managerPluginReconciliationTail: Promise<void> = Promise.resolve();
  const developerCandidateAdmission = new DeveloperCandidateAdmission({
    sourceRoot: process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT || packageRoot,
    identity: () => {
      const current = managerPluginKernel!.current();
      return { applicationGenerationId: current.applicationGenerationId, managerInstanceId: current.managerInstanceId, pluginGenerationId: current.id };
    }
  });
  const managerSourcePatches = new ManagerSourcePatchService({
    developerSourceRoot: process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT || packageRoot,
    developerAdmission: developerCandidateAdmission,
    developerDiagnostic: message => managerOperationalLog.record("warn", "developer_verification_existing_contract", { owner: "manager_patch_publication", result: message }),

    baselineRoot: path.join(packageRoot, "dist", "source-patches"),
    stateRoot: path.join(rootDir, "data", ".runtime", "source-patches"),
    bundleJournalRoot: path.join(rootDir, "data", ".runtime", "source-patches", "bundles"),
    runtime: managerPluginKernel!,
    audit: (event, fields) => managerOperationalLog.record("info", event, { result: JSON.stringify(fields) })
  });
  managerSourcePatchStatus = () => managerSourcePatches.status();
  managerRuntimeOwner.register("manager_source_patches", () => managerSourcePatches.stop());
  const managerWebPatches = new WebPatchService({
    developerSourceRoot: process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT || packageRoot,
    developerAdmission: developerCandidateAdmission,
    developerDiagnostic: message => managerOperationalLog.record("warn", "developer_verification_existing_contract", { owner: "manager_patch_publication", result: message }),

    packageRoot, stateRoot: path.join(rootDir, "data/.runtime/web-patches"),
    identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId, pluginGenerationId: managerPluginKernel!.current().id }),
    serialize: (generation, operation) => managerPluginKernel!.publishSourcePatch(generation, operation),
    audit: (event, fields) => managerOperationalLog.record("info", event, { result: JSON.stringify(fields) })
  });
  managerRuntimeOwner.register("manager_web_patches", () => managerWebPatches.stop());
  const automaticCodeService = new AutomaticCodeService({
    packageRoot, sourceRoot: process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT,
    stateRoot: path.join(rootDir, "data/.runtime/automatic-code"),
    watch: process.env.RABIROUTE_HOT_PATCH_WATCH !== "0", publication: managerWebPatches,
    onError: error => managerOperationalLog.record("error", "automatic_update_failed", { result: String(error) })
  });
  managerRuntimeOwner.register("manager_automatic_updates", () => automaticCodeService.stop());
  void automaticCodeService.start().catch(error => managerOperationalLog.record("error", "automatic_update_start_failed", { result: String(error) }));
  if (process.env.RABIROUTE_HOT_PATCH_WATCH !== "0" && process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT) {
    const webPatchWatcher = new WebPatchWatcher(process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT, managerWebPatches,
      error => managerOperationalLog.record("error", "web_patch_marker_failed", { result: String(error) }));
    managerRuntimeOwner.register("manager_web_patch_marker", () => webPatchWatcher.stop());
  }
  let sourcePatchWatcherStart: Promise<SourcePatchWatcher | undefined> | undefined;
  managerRuntimeOwner.register("manager_source_patch_watcher", async () => {
    const watcher = await sourcePatchWatcherStart;
    await watcher?.stop();
  });
  const startOptionalSourcePatchWatcher = (): Promise<SourcePatchWatcher | undefined> => sourcePatchWatcherStart ??= (async () => { try {
    const sourcePatchWatcher = await SourcePatchWatcher.start({
      root: packageRoot,
      sourceRoot: process.env.RABIROUTE_HOT_PATCH_SOURCE_ROOT || undefined,
      service: managerSourcePatches,
      runtime: managerPluginKernel!,
      outputDirectory: path.join(rootDir, "data", ".runtime", "source-patches", "candidates"),
      enabled: process.env.RABIROUTE_HOT_PATCH_WATCH !== "0",
      onError: error => managerOperationalLog.record("error", "source_patch_watcher_failed", {
        result: error instanceof Error ? error.message : String(error)
      })
    });
    return sourcePatchWatcher ?? undefined;
  } catch (error) {
    await managerOperationalLog.record("error", "source_patch_watcher_start_failed", {
      result: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  } })();
  const reconcileManagerPlugins = (
    reason: string,
    options: Readonly<{ readyOnly?: boolean; invocation?: PluginCatalogInvocation; reuseUnchangedPackages?: boolean; startupContinuation?: boolean }> = {}
  ): Promise<void> => {
    const assertReconciliationOpen = (): void => {
      if (shuttingDown) throw new Error("Manager plugin reconciliation stopped during shutdown.");
      options.invocation?.assertCurrent();
    };
    const reconciliation = managerPluginReconciliationTail.then(async () => {
      assertReconciliationOpen();
      const previousProfile = loadedManagerPluginProfile;
      const previousGenerationId = managerPluginKernel!.current().id;
      const reuseStartupRequired = options.startupContinuation && startupRequiredGenerationId === previousGenerationId;
      startupRequiredGenerationId = undefined;
      const desiredProfile = (await managerPluginSettings.snapshot()).profile;
      const loaded = await loadPluginProfile({
        profilePath: managerPluginProfilePath,
        profile: desiredProfile,
        packageCatalog: managerPluginPackageCatalog,
        runtimeRoot: path.join(rootDir, "data", "plugins", ".runtime"),
        preparationFailure: (packageId, instanceId) => pluginStorageMigrationFailure(packageId, rootDir, instanceId),
        host: "manager",
        previous: previousProfile,
        readyOnly: options.readyOnly ? {
          hostCapabilities: managerPluginHostServices.map(service => service.capability),
          readManifest: (packageId, version) => readPluginManagementManifest(managerPluginPackageCatalog, packageId, version)
        } : undefined,
        reuseUnchangedPackages: reuseStartupRequired ? true : options.reuseUnchangedPackages,
        assertCurrent: assertReconciliationOpen
      });
      assertReconciliationOpen();
      const metadata = pluginProfilePackageResolution(options.readyOnly ? loaded.profile : desiredProfile, loaded, managerPluginPackageCatalog);
      const manifestReads = new Map<string, ReturnType<typeof readPluginManagementManifest>>();
      const readInstalledManifest = (packageId: string, version: string) => {
        const key = JSON.stringify([packageId, version]);
        let reading = manifestReads.get(key);
        if (!reading) { reading = readPluginManagementManifest(metadata.catalog, packageId, version); manifestReads.set(key, reading); }
        return reading;
      };
      const [ownership, routeOwnership, agentOwnership] = await Promise.all([
        readInstalledGatewayEndpointTypes(metadata.profile, readInstalledManifest),
        readInstalledEndpointRouteDeclarations(metadata.profile, metadata.catalog, readInstalledManifest),
        loadInstalledAgentManagerDescriptors(metadata.profile, metadata.catalog, readInstalledManifest)
      ]);
      assertReconciliationOpen();
      installedGatewayEndpointTypes = ownership.types;
      installedEndpointRouteDeclarations = routeOwnership.declarations;
      installedAgentDescriptors = new Map(agentOwnership.descriptors.map(descriptor => [descriptor.type, descriptor]));
      releaseAgentMetadataProjection ??= installAgentAdapterManifestReader(() =>
        [...currentAgentSessionDescriptors().values()].map(descriptor => descriptor.manifest as AgentAdapterManifest));
      for (const diagnostic of agentOwnership.diagnostics) managerOperationalLog.record("warn", "agent_package_descriptor_unavailable", {
        owner: diagnostic.instanceId, error: managerOperationalError(new Error(diagnostic.message), rootDir)
      });
      for (const diagnostic of ownership.diagnostics) managerOperationalLog.record("warn", "endpoint_host_declaration_unavailable", {
        owner: diagnostic.instanceId, error: managerOperationalError(new Error(diagnostic.message), rootDir)
      });
      for (const diagnostic of routeOwnership.diagnostics) if (!ownership.diagnostics.some(item => item.instanceId === diagnostic.instanceId)) managerOperationalLog.record("warn", "endpoint_route_declaration_unavailable", {
        owner: diagnostic.instanceId, error: managerOperationalError(new Error(diagnostic.message), rootDir)
      });
      // Package loading prepares requested metadata; only a published activation
      // can replace the confirmed package/configuration used by future fallback.
      assertReconciliationOpen();
      for (const failure of loaded.loadFailures) {
        managerOperationalLog.record("warn", "plugin_package_load_failed", {
          result: `instance=${failure.instanceId}; package=${failure.packageId}@${failure.version}; retainedRevision=${failure.retainedRevision ?? "none"}`,
          error: managerOperationalError(new Error(failure.error.message), rootDir)
        });
      }
      let published = false;
      try {
        pendingManagerPluginProfile = loaded;
        const candidates = options.readyOnly
          ? selectReadyPluginCandidates(
            loaded.candidates,
            loaded.profile.readyRequires,
            managerPluginHostServices.map(service => service.capability)
          )
          : loaded.candidates;
        assertReconciliationOpen();
        const selection = await developerCandidateAdmission.prepareSelection(candidates, previousProfile?.candidates ?? [], options.invocation?.signal);
        for (const diagnostic of selection.diagnostics) managerOperationalLog.record("warn", "developer_verification_existing_contract", {
          owner: "manager_plugin_publication", result: diagnostic
        });
        for (const failure of selection.failures) managerOperationalLog.record("warn", "developer_candidate_verification_failed", {
          owner: "manager_plugin_publication", action: failure.instanceId,
          result: failure.retained ? "previous_candidate_retained" : "candidate_not_published",
          error: managerOperationalError(new Error(failure.reason), rootDir)
        });
        // The immutable candidate proof belongs to this desired reconciliation.
        // Its first publication consumes the original plugin-generation baseline;
        // subsequent components keep the live request/application fence below.
        assertReconciliationOpen();
        const result = await managerPluginKernel!.switch(selection.candidates, {
          readyRequires: loaded.profile.readyRequires,
          requiredCapabilityPolicy: "report",
          initialization: options.readyOnly ? "await" : "background",
          beforePublish: createPluginReconciliationPublicationFence(assertReconciliationOpen, selection.assertCurrent)
        });
        published = true;
        // Complete committed-generation bookkeeping even if the caller expires after publication.
        // The original invocation is rechecked before returning or disclosing its result.
        capturePluginGeneration(result.generation);
        if (options.readyOnly) startupRequiredGenerationId = result.generation.id;
        if (managerServicesReady && !managerReadOnly) syncRunningGateways();
        const active = result.generation.records.filter(record => record.status === "active").map(record => record.identity.instanceId);
        const waiting = result.generation.records.filter(record => record.status === "waiting_dependency").map(record => record.identity.instanceId);
        const failed = result.generation.records.filter(record => record.status === "failed").map(record => record.identity.instanceId);
        publishManagerEvent("plugin_reconciliation_changed", { reason, state: "idle", active, waiting, failed, diagnostics: managerPluginDiagnostics });
        publishManagerEvent("plugin_catalog_changed", {
          reason,
          generation: result.generation.id,
          revision: { plugins: result.generation.sequence, contributions: result.generation.contributions.revision }
        });
        if (!options.readyOnly) {
          refreshStartupPresentation();
          // Retain this prepared metadata while its original activation flights finish.
          // Joining occurs outside the metadata queue, so another plugin can be removed meanwhile.
          void managerPluginKernel!.settle().then(() => {
            if (!shuttingDown && managerServicesReady && !managerReadOnly) syncRunningGateways();
          }).catch(error => managerOperationalLog.record("warn", "plugin_async_initialization_failed", {
            error: managerOperationalError(error, rootDir)
          })).finally(() => {
            if (!shuttingDown) {
              const current = managerPluginKernel!.current();
              capturePluginGeneration(current);
              publishManagerEvent("plugin_catalog_changed", { reason: "plugin initialization settled", generation: current.id,
                revision: { plugins: current.sequence, contributions: current.contributions.revision } });
            }
            if (pendingManagerPluginProfile === loaded) pendingManagerPluginProfile = undefined;
          });
        }
        assertReconciliationOpen();
      } catch (error) {
        // Publication can precede post-publication cleanup. Never restore package
        // metadata for the old graph after a new graph has already become visible.
        if (!published && managerPluginKernel!.current().id === previousGenerationId) loadedManagerPluginProfile = previousProfile;
        throw error;
      } finally {
        if ((!published || options.readyOnly) && pendingManagerPluginProfile === loaded) pendingManagerPluginProfile = undefined;
      }
    });
    managerPluginReconciliationTail = reconciliation.catch(() => {});
    return reconciliation;
  };

  managerRuntimeOwner.register("manager_plugin_reconciliation", () => {
    startupRequiredGenerationId = undefined;
    return managerPluginReconciliationTail;
  });
  const bootstrapCore = Object.freeze({
createWebguiAccessOperations: () => createWebguiAccessOperations({
        readPayload: publicWebguiLanAccessPayload,
        readConfig: () => rabiGlobalConfig.read().webguiLan,
        saveConfig: webguiLan => { rabiGlobalConfig.patch({ webguiLan }); },
        generateToken: generateWebguiAccessToken,
        canManage: request => hasAuthenticatedConnectionRequest(request)
          || isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address))
      }),
createWebguiStaticOperations: () => createWebguiStaticOperations(new NativeWebguiStaticOwner({
        packageRoot, webuiDistPath,
        patches: {
          candidates: managerWebPatches.candidates,
          status: () => managerWebPatches.status(),
          staticManifest: revision => managerWebPatches.staticManifest(revision)
        },
        isControlPath: isManagerControlRequestPath,
        onSlowFs: detail => {
          if (!managerOperationalLog.isEnabled("filesystem", "warn")) return;
          const diagnostic = JSON.stringify(detail);
          managerOperationalLog.record("warn", "filesystem_await_stalled", {
            group: "filesystem", owner: detail.owner, requestId: detail.requestId,
            durationMs: detail.operationElapsedMs, result: diagnostic
          });
          try { process.stderr.write("[RabiRoute filesystem await] " + diagnostic + "\n"); }
          catch { managerOperationalLog.record("warn", "filesystem_diagnostic_stderr_failed", { group: "filesystem", owner: detail.owner }); }
        }
      })),
createPluginCatalogOperations: () => createPluginCatalogOperations({
        runtime: managerPluginKernel!,
        root: () => packageRoot,
        renderCatalog: async (input, host, invocation) => {
          invocation?.assertCurrent();
          const value = await managerSourcePatches.invoke("manager.plugin-catalog", "renderPluginCatalog", [input, host]);
          invocation?.assertCurrent(); return value;
        },
        reconciliation: {
          diagnostics: () => managerPluginDiagnostics,
          readiness: generation => managerPluginGenerationStatus?.id === generation.id
            ? managerPluginGenerationStatus.readiness : generation.readiness,
          reconcile: async invocation => {
            await reconcileManagerPlugins("manual API request", { invocation });
            // Join outside the metadata queue: a slow plugin cannot block another settings intent.
            await managerPluginKernel!.settle();
            invocation.assertCurrent(); return managerPluginKernel!.current();
          }
        },
        webModules: {
          list: async (webRelease, invocation) => {
            invocation?.assertCurrent(); const value = await managerWebPatches.modules(webPluginModules.list(), webRelease);
            invocation?.assertCurrent(); return value;
          },
          read: async (id, rev, relativePath, invocation) => {
            invocation?.assertCurrent();
            const value = await managerWebPatches.module(webPluginModules.list(), id, rev, relativePath)
              ?? await webPluginModules.read(id, rev, relativePath);
            invocation?.assertCurrent(); return value;
          }
        }
      }, managerReadOnly),
createManagerEventOperationDefinition
  });
  const managerBootstrapAbort = new AbortController();
  const managerBootstrap = await registerManagerBootstrap({
    registry: managerPluginRoutes,
    applicationOwner: managerApplicationRoutes,
    publicOperations: managerCorePublicOperations,
    catalogOperations: () => bootstrapCore.createPluginCatalogOperations(),
    accessOperations: () => bootstrapCore.createWebguiAccessOperations(),
    eventOperation: () => bootstrapCore.createManagerEventOperationDefinition(),
    staticOperations: () => bootstrapCore.createWebguiStaticOperations()
  }, managerBootstrapAbort.signal);
  managerRuntimeOwner.register("manager_bootstrap", () => { managerBootstrapAbort.abort(); return managerBootstrap.dispose(); });

  const managerPluginPackageStore = new PluginPackageStore({ roots: managerPluginPackageRoots, managedRoot: managedPluginPackageRoot, bundledRoot: builtinPluginPackageRoot,
    importRuntimeRoot: path.join(rootDir, "data", "plugins", ".runtime", "imports") });
  webPluginModules.setPackageCatalog(retainedWebPackageCatalog({ packages: managerPluginPackageStore,
    catalog: managerPluginPackageCatalog, runtimeRoot: path.join(rootDir, "data", "plugins", ".runtime") }));
  const pluginManagement = createPluginManagement({
    runtime: managerPluginKernel!, settings: managerPluginSettings,
    manifest: (packageId, version) => readPluginManagementManifest(managerPluginPackageCatalog, packageId, version),
    packageSource: async (packageId, version) => (await managerPluginPackageCatalog.resolve(packageId, version)).sourceRoot,
    reconcile: () => reconcileManagerPlugins("committed plugin instance settings changed", { reuseUnchangedPackages: true }),
    packages: managerPluginPackageStore,
    changed: () => { webPluginModules.invalidatePackageCatalog(); refreshStartupPresentation(); }
  });
  const pluginManagementRegistration = managerApplicationRoutes.run(() => managerPluginRoutes.registerOperations(managerApplicationRoutes.instanceId, createPluginManagementOperations({
    runtime: managerPluginKernel!, root: () => packageRoot,
    renderCatalog: async () => ({ revision: managerPluginKernel!.current().sequence, contract: {}, value: {} }),
    management: pluginManagement
  }, managerReadOnly)));
  managerRuntimeOwner.register("plugin_management_api", () => pluginManagementRegistration.dispose());

  const restartForDataUpgrade = createDataUpgradeHostRestart({
    layout: { packageRoot, stateRoot: rootDir },
    generation: () => managerHostIdentity?.applicationGenerationId ?? "",
    hosted: Boolean(managerHostIdentity),
    hostExecutable: process.env.RABIROUTE_HOST_EXECUTABLE
  });
  const dataUpgrades = new DataUpgradeService({
    layout: { packageRoot, stateRoot: rootDir }, rolesRoot: managerRolesRoot, readOnly: managerReadOnly,
    ...(managerHostIdentity ? { requestRestart: restartForDataUpgrade } : {})
  });
  const unsubscribeDataUpgrades = dataUpgrades.subscribe(status => publishManagerEvent(DATA_UPGRADE_STATUS_EVENT, status));
  const dataUpgradeRegistration = managerApplicationRoutes.run(() => managerPluginRoutes.registerOperations(
    managerApplicationRoutes.instanceId,
    createDataUpgradeOperations({ service: dataUpgrades, canManage: () => true })
  ));
  managerRuntimeOwner.register("data_upgrades", async () => {
    unsubscribeDataUpgrades();
    await dataUpgradeRegistration.dispose();
    await dataUpgrades.stop();
  });

  const managerPluginStartupStartedAt = Date.now();
  try {
    await reconcileManagerPlugins("manager startup required capabilities", { readyOnly: true });
  } catch (error) {
    await failManagerStartup("manager_plugin_startup", error);
  }
  const initialPluginReadiness = managerPluginKernel!.current().readiness;
  if (initialPluginReadiness.missingCapabilities.length) {
    managerOperationalLog.record("warn", "plugin_startup_degraded", {
      durationMs: Math.max(0, Date.now() - managerPluginStartupStartedAt),
      result: "Manager stays live with unavailable plugin capabilities: " + initialPluginReadiness.missingCapabilities.join(", ")
    });
  }
  let configWatcher: ConfigWatcher | null = null;
  let pluginPackageWatcher: PluginPackageWatcher | null = null;
  let managerResourcesStopped = false;

  function stopManagerResources(): void {
    if (managerResourcesStopped) return;
    managerResourcesStopped = true;
    gatewayDiagnosticsSnapshotService?.stop();
    gatewayDiagnosticsSnapshotService = undefined;
    closeManagerEventClients();
  }
  managerRuntimeOwner.register("recording_archive", () => recordingArchiveRuntime.dispose());
  if (!managerReadOnly) {
    // The instance identity is assigned before plugin startup; never freeze the initial empty value.
    if (!managerInstanceId) throw new Error("archive_asr_instance_identity_missing");
    const archiveAsr = new RecordingArchiveAsrRuntime({
      archive: recordingArchiveRuntime,
      localSpeechUrl: () => speechServiceUrl(),
      workerId: () => rabiLinkRelayConfigForMeta().deviceId,
      instanceId: managerInstanceId,
      changed: () => publishManagerEvent("all_day_recording", { mobile: true })
    });
    recordingArchiveAsrRuntime = archiveAsr;
    // RuntimeOwner disposes in reverse registration order: stop ASR before its archive store.
    managerRuntimeOwner.register("recording_archive_asr", () => archiveAsr.dispose());
    // NAS recovery is optional business readiness, not a Manager READY prerequisite.
    void recordingArchiveRuntime.restore().then(async outcomes => {
      console.log(JSON.stringify({ event: "recording_archive_restore", ready: outcomes.filter(item => item.ready).length, unavailable: outcomes.filter(item => !item.ready).length }));
      const asr = await archiveAsr.restore();
      console.log(JSON.stringify({ event: "recording_archive_asr_restore", ready: asr.filter(item => item.ready).length, unavailable: asr.filter(item => !item.ready).length }));
    }).catch(() => {
      console.error(JSON.stringify({ event: "recording_archive_restore_failed", code: "archive_unavailable" }));
    });
  }
  managerRuntimeOwner.register("all_day_recording", () => allDayRecording.dispose());
  managerRuntimeOwner.register("companion_activity", async () => { await companionActivity.dispose(); await companionFrameDelivery.dispose(); });
  managerRuntimeOwner.register("request_scoped_resources", () => stopManagerResources());
  managerRuntimeOwner.register("manual_trigger_processes", () => manualTriggerProcesses.stopAll());

  try {
  managerServicesReady = true;
  if (managerReadOnly) {
    console.log("Manager read-only mode enabled: startup reconciliation and mutating HTTP methods are disabled.");
  }

  const handleManagerRequest = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    const method = request.method ?? "UNKNOWN";
    let pathname = "/";
    void runWithOperationContext(createOperationContext({
      traceId: requestId,
      spanId: requestId,
      requestId,
      source: "http",
      actor: { kind: "system", id: "manager-http" }
    }), async () => {
    managerRequestContexts.set(response, {
      requestId,
      method,
      pathname: () => pathname,
      startedAt: requestStartedAt,
      peerAddress: request.socket.remoteAddress,
      peerPort: request.socket.remotePort
    });
    response.setHeader("x-rabiroute-request-id", requestId);
    const transportContext = managerClientTransportIdentity.capture(response);
    observeManagerHttpAbort(response, () => managerOperationalLog.record("warn", "http_request_aborted", {
      requestId, method, pathname, durationMs: Math.max(0, Date.now() - requestStartedAt), result: "aborted"
    }));
    response.once("finish", () => {
      const durationMs = Math.max(0, Date.now() - requestStartedAt);
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
      const failed = response.statusCode >= 400;
      const slow = durationMs >= 2_000;
      const context = managerRequestContexts.get(response);
      recordManagerHttpRequest(
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
        ...(context?.peerAddress !== undefined || context?.peerPort !== undefined
          ? { peer: { address: context?.peerAddress, port: context?.peerPort } } : {}),
        result: failed ? "failed" : "completed"
      });
    });
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      pathname = requestUrl.pathname;
      if (rabiLinkTransportAssertionPresent(request) && !rabiLinkTrustedTransport(request,
        managerHostIdentity?.applicationGenerationId ?? managerInstanceId, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()))) {
        jsonResponse(response, 403, { code: -1, error: "INTERNAL_TRANSPORT_AUTHORITY_INVALID" });
        return;
      }
      const lanAgentAccess = evaluateLanAgentRequest(request, lanAgentAuthority, rabiGlobalConfig.read().webguiLan.enabled,
        () => rabiGlobalConfig.getLanAgentAdmissionPolicy());
      if (lanAgentAccess.kind === "denied") {
        response.setHeader("cache-control", "no-store");
        response.setHeader("Connection", "close");
        response.once("finish", () => request.socket.destroySoon());
        jsonResponse(response, lanAgentAccess.status, { code: -1, error: lanAgentAccess.error });
        return;
      }
      if (lanAgentAccess.kind === "agent") {
        managerRequestContexts.get(response)!.assertResponseAuthority = () => { assertTrustedLanAgentPrincipal(request); };
        const skillAccess = authorizeLanAgentRoleSkillRequest(
          lanAgentAccess, request.method, pathname
        );
        if (!skillAccess.allowed) {
          jsonResponse(response, skillAccess.status, { code: -1, error: skillAccess.error });
          return;
        }
        captureTrustedLanAgentSource(request, rabiGlobalConfig.getLanAgentDeliveryPolicy().incarnation);
      }
      if (managerClientTransportIdentity.rejectChanged(request, response, transportContext)) return;
      guardRequestBodyDeadline(request, response, {
        normalMs: managerHttpLimits.requestTimeoutMs,
        uploadMs: 30 * 60 * 1000,
        isAuthorizedUpload: request.method === "PUT"
          && /^\/api\/agent\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(pathname)
          && Boolean(getTrustedLanAgentSource(request))
      });
      if (handleManagerLanDiscoveryRequest(request, requestUrl, response, {
        enabled: !managerReadOnly
          && managerListensOnLan(managerHost)
          && rabiGlobalConfig.read().webguiLan.enabled,
        document: () => {
          const config = rabiGlobalConfig.read();
          return Object.freeze({
            protocolVersion: MANAGER_DISCOVERY_PROTOCOL_VERSION,
            applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
            managerInstanceId,
            guid: config.rabiGuid,
            name: config.rabiName,
            computerName: os.hostname(),
            deviceType: "RabiRoute Manager" as const,
            version: rabiRoutePackageVersion()
          });
        },
        jsonResponse
      })) {
        return;
      }
      if (handleRemotePersonaResolutionApi(request, requestUrl, response, {
        identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId }),
        isLoopback: isLoopbackRemoteAddress,
        definition: routeId => runtimes.get(routeId)?.definition,
        verifyCapability: (routeId, roleId, capability) => currentPersonaMessageAuthority().verify(routeId, roleId, capability),
        resolve: definition => resolveRemotePersonaSnapshot(definition, remotePersonaReadContext()),
        reportFailure: (routeId, error) => managerOperationalLog.record("warn", "remote_persona_read_failed", {
          action: routeId, error: managerOperationalError(error, rootDir)
        }),
        json: jsonResponse
      })) return;
      if (handleRoleContextProjectionRequest(request, requestUrl, response, {
        identity: {
          applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
          managerInstanceId
        },
        isLoopback: isLoopbackRemoteAddress,
        verifyCapability: (routeId, roleId, capability) => {
          const definition = runtimes.get(routeId)?.definition;
          return Boolean(definition && !definition.agentRoleDeviceId && definition.agentRoleId === roleId
            && currentPersonaMessageAuthority().verify(routeId, roleId, capability));
        },
        readJsonBody,
        resolve: body => {
          const roleDir = roleDirForApi(body.roleId);
          return roleKnowledgeSnapshotFromPublishedCatalog(roleDir, String(body.signalText || ""), {
            roleId: body.roleId,
            includePendingConsolidation: body.includePendingConsolidation,
            consolidationTrigger: body.consolidationTrigger,
            archiveCompletedPlans: true,
            touchViewedAt: true
          });
        },
        requestRefresh: roleId => requestRoleKnowledgeCatalogRefresh(roleDirForApi(roleId)),
        jsonResponse
      })) {
        return;
      }
      const enrollmentAccess = rabiGlobalConfig.read().webguiLan.enabled && (
        isLanNodeMetadataRequest(request, lanAgentAuthority)
        || (request.method === "POST" && pathname === "/api/lan-agent/enroll")
        || (request.method === "GET" && (pathname.startsWith("/api/lan-agent/releases/") || pathname === "/api/lan-agent/self") && (() => {
          const token = headerValue(request.headers.authorization).match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
          return lanAgentAuthority.validateBootstrapTicket(token) || Boolean(lanAgentAuthority.authenticate(token));
        })())
      );
      // Enabled ingress-authenticated Agents have local-equivalent public management
      // authority. Private protocol handlers keep their own authentication boundaries.
      const managementAccessAllowed = lanAgentAccess.kind === "agent"
        ? Boolean(assertTrustedLanAgentPrincipal(request))
        : enrollmentAccess || webguiLanRequestAllowed(request, requestUrl);
      if (!managementAccessAllowed) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("www-authenticate", "Bearer realm=\"RabiRoute WebGUI\"");
        jsonResponse(response, 401, {
          code: -1,
          error: "WEBGUI_TOKEN_REQUIRED",
          message: "局域网访问需要有效的 RabiRoute WebGUI 访问密钥。请使用控制台生成的完整访问链接。"
        });
        return;
      }
      // EventSource/resource requests use the existing browser query credential.
      // Authentication retains the original URL; business schemas receive no credential field.
      markConsumedConnectionQueryParameters(request, [WEBGUI_TOKEN_QUERY_KEY]);
      if (!enrollmentAccess && (lanAgentAccess.kind === "agent" || !isLoopbackRemoteAddress(request.socket.remoteAddress) || localModelSettingsRequestAllowed(request)
        || rabiLinkTrustedTransport(request, managerHostIdentity?.applicationGenerationId ?? managerInstanceId, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())))) {
        const admittedGeneration = managerHostIdentity?.applicationGenerationId ?? managerInstanceId;
        const admittedRabiLink = rabiLinkTrustedTransport(request, admittedGeneration, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()));
        const admittedRabiLinkScope = admittedRabiLink ? rabiLinkConnectionScope(rabiLinkRelayConfigForMeta()) : undefined;
        markAuthenticatedConnectionRequest(request, () => {
          if (lanAgentAccess.kind === "agent") assertTrustedLanAgentPrincipal(request);
          if (admittedRabiLink && (!admittedRabiLinkScope
            || admittedRabiLinkScope !== rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())
            || !rabiLinkTrustedTransport(request, managerHostIdentity?.applicationGenerationId ?? managerInstanceId, rabiLinkConnectionScope(rabiLinkRelayConfigForMeta())))) {
            throw new Error("Authenticated connection scope or generation was revoked.");
          }
          if (lanAgentAccess.kind !== "agent"
            && !webguiLanRequestAllowed(request, requestUrl)) throw new Error("Authenticated Manager connection was revoked.");
        });
      }
      if (managerReadOnly && !managerReadOnlyRequestAllowed(request.method, pathname)) {
        jsonResponse(response, 423, {
          code: -1,
          message: "Manager is running in read-only acceptance mode."
        });
        return;
      }
      if (handleManagerHostLifecycleRequest(request, requestUrl, response, {
        identity: managerHostIdentity,
        shutdown: reason => shutdownManager(reason),
        jsonResponse
      })) {
        return;
      }
      if (handleSourcePatchApi(request, requestUrl, response, {
        service: managerSourcePatches,
        identity: managerHostIdentity,
        readJson: readJsonBody,
        json: jsonResponse
      })) return;
      if (handleWebPatchApi(request, requestUrl, response, {
        service: managerWebPatches, identity: managerHostIdentity, readJson: readJsonBody, json: jsonResponse
      })) return;
      const routeCatalogRejection = routeCatalogStartupUnavailable(
        request.method,
        requestUrl.pathname,
        routeCatalogStartupLifecycle.snapshot()
      );
      if (routeCatalogRejection) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("retry-after", String(routeCatalogRejection.retryAfterSeconds));
        jsonResponse(response, routeCatalogRejection.statusCode, routeCatalogRejection.body);
        return;
      }
      // Generation publication removes the failed owner and its actual dependents.
      // Unrelated registered operations retain their own authority and storage gates.
      if (managerPluginRoutes.handle(request, requestUrl, response)) {
        return;
      }
      if (isManagerControlRequestPath(requestUrl.pathname)) {
        jsonResponse(response, 404, { code: -1, message: "Manager API route not found." });
        return;
      }
      jsonResponse(response, 503, { code: -1, message: "Manager static resource owner is unavailable." });
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
    }).catch(error => { response.destroy(error instanceof Error ? error : new Error("Manager request failed.")); });
  };

  activeServer.requestTimeout = getTimeoutMs("http.outerRequest", 30 * 60 * 1000); // Per-request body deadlines retain the ordinary 30-second limit.
  activeServer.headersTimeout = managerHttpLimits.headersTimeoutMs;
  activeServer.keepAliveTimeout = managerHttpLimits.keepAliveTimeoutMs;
  activeServer.maxRequestsPerSocket = managerHttpLimits.maxRequestsPerSocket;
  const managedUpgrade = (request: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    try {
      const url = new URL(request.url || "/", "http://manager.invalid");
      if (!managerPluginRoutes.handleUpgrade(request, url, socket, head)) socket.destroy();
    }
    catch { socket.destroy(); }
  };
  activeServer.on("upgrade", managedUpgrade);
  managerRuntimeOwner.register("manager_plugin_upgrade", () => { activeServer.removeListener("upgrade", managedUpgrade); });

  let planDependentBackgroundStarted = false;
  let planDependentBackgroundFlight: Promise<void> | undefined;
  let roleKnowledgeRetryTimer: NodeJS.Timeout | undefined;
  managerRuntimeOwner.register("role_knowledge_startup_retry", () => {
    if (roleKnowledgeRetryTimer) clearTimeout(roleKnowledgeRetryTimer);
    roleKnowledgeRetryTimer = undefined;
  });
  const startPlanDependentBackground = (): void => {
    if (planDependentBackgroundStarted || planDependentBackgroundFlight || shuttingDown || managerReadOnly) return;
    if (!["ready", "partial"].includes(planStorageStartupLifecycle.snapshot().state)) return;
    if (routeCatalogStartupLifecycle.snapshot().state !== "ready") return;
    planDependentBackgroundFlight = (async () => {
      roleKnowledgeCatalogsReady = await prewarmRolePlanCatalogs();
      if (shuttingDown) return;
      if (!roleKnowledgeCatalogsReady) {
        roleKnowledgeRetryTimer = setTimeout(() => {
          roleKnowledgeRetryTimer = undefined;
          startPlanDependentBackground();
        }, 2_000);
        roleKnowledgeRetryTimer.unref();
        return;
      }
      planDependentBackgroundStarted = true;
      syncRunningGateways();
      void reconcilePersistedPlanSecretaryWorkspaces();
      startActivePlanFeedbackRecovery();
      memoryConsolidationScheduler?.start();
    })().finally(() => {
      planDependentBackgroundFlight = undefined;
    });
  };
  planStorageStartupLifecycle.onReady(() => startPlanDependentBackground());
  routeCatalogStartupLifecycle.onReady(() => {
    syncRunningGateways();
    messageEndpointManagers.ready();
    if (!planDependentBackgroundStarted) {
      startPlanDependentBackground();
    } else {
      memoryConsolidationScheduler?.reschedule();
    }
  });
  let managerLanDiscoveryFlight: ReturnType<typeof startManagerDiscoveryPublisher> | undefined;
  managerRuntimeOwner.register("manager_lan_discovery", async () => {
    const publisher = await managerLanDiscoveryFlight?.catch(() => undefined);
    await publisher?.stop();
  });
  const startLanDiscovery = async (): Promise<void> => {
  const lanDiscoveryEnabled = !managerReadOnly
    && managerListensOnLan(managerHost)
    && rabiGlobalConfig.read().webguiLan.enabled;
  if (lanDiscoveryEnabled) {
    try {
      managerLanDiscoveryFlight = startManagerDiscoveryPublisher({
        port: managerPort,
        applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
        managerInstanceId,
        guid: rabiGlobalConfig.read().rabiGuid,
        onStatus: status => { managerLanDiscoveryStatus = status; }
      });
      await managerLanDiscoveryFlight;
      if (shuttingDown) return;
    } catch (error) {
      if (shuttingDown) return;
      managerLanDiscoveryStatus = Object.freeze({
        state: "failed",
        serviceType: "_rabiroute._tcp.local",
        port: managerPort,
        message: error instanceof Error ? error.message : String(error)
      });
      managerOperationalLog.record("warn", "manager_lan_discovery_failed", {
        result: `port=${managerPort}`,
        error: managerOperationalError(error, rootDir)
      });
    }
  } else {
    managerLanDiscoveryStatus = Object.freeze({
      state: "disabled",
      serviceType: "_rabiroute._tcp.local"
    });
  }

  };

  activeGatewayDiagnosticsSnapshotService().requestRefresh({ force: true });
  void syncActiveRabiLinkRelay().catch(error => {
    managerOperationalLog.record("warn", "rabilink_relay_startup_failed", {
      result: "Manager control plane stays live",
      error: managerOperationalError(error, rootDir)
    });
  });
  messageEndpointManagers.ready();
  if (!managerReadOnly) reconcileActiveSpeech();

  try {
    configWatcher = managerShouldAutostart && managerConfigWatcherEnabled()
      ? startConfigWatcher(reconcileManagerPlugins, () => syncActiveRabiLinkRelay())
      : null;
    if (configWatcher) {
      const acquiredConfigWatcher = configWatcher;
      managerRuntimeOwner.register("config_watcher", () => acquiredConfigWatcher.close());
    }
    if (!configWatcher) {
      configWatchLifecycle = disabledManagerWatchBrokerStatus();
      console.log("Route config event watcher disabled by RABIROUTE_MANAGER_AUTOSTART=0");
    }
  } catch (error) {
    configWatchLifecycle = Object.freeze({
      ...disabledManagerWatchBrokerStatus(),
      state: "degraded",
      partial: true,
      errors: [error instanceof Error ? error.message : String(error)]
    });
  }
  try {
    pluginPackageWatcher = startPluginPackageWatcher(
      [...managerPluginPackageRoots, path.dirname(managerPluginProfilePath)],
      reconcileManagerPlugins
    );
    const acquiredPluginPackageWatcher = pluginPackageWatcher;
    managerRuntimeOwner.register("plugin_package_watcher", () => acquiredPluginPackageWatcher.close());
  } catch (error) {
    pluginPackageWatchLifecycle = Object.freeze({
      ...disabledManagerWatchBrokerStatus(),
      state: "degraded",
      partial: true,
      errors: [error instanceof Error ? error.message : String(error)]
    });
  }
  if (managerRuntimeOwner.isTearingDown()) return;
  managerRuntimeOwner.publish(Object.freeze({
    roleStorage: roleStorageApplication,
    planStorage: planStorageStartupLifecycle,
    routeCatalog: routeCatalogStartupLifecycle,
    requestHandler: withAutomaticCodeRequest(handleManagerRequest)
  }));
  console.log(`gateway-manager listening on http://${managerHost}:${managerPort}`);
  console.log(`roles: ${configRepository.domainRoot("roles").value ?? "unavailable: repair rolesDir"}`);
  console.log(`route: ${configRepository.domainRoot("route").value ?? "unavailable: repair routeDir"}`);
  managerOperationalLog.record("info", "manager_listening", {
    result: `host=${managerHost}; port=${managerPort}; readOnly=${managerReadOnly}`
  });
  managerListenerReady = true;
  if (managerHostIdentity) {
    console.log(managerReadyLine({
      protocolVersion: 1,
      applicationGenerationId: managerHostIdentity.applicationGenerationId,
      managerInstanceId,
      pid: process.pid,
      baseUrl: managerBaseUrl,
      readyAt: new Date().toISOString()
    }));
    resolveWearableCompanionStartup();
  }
  void reconcileManagerPlugins("post-ready optional activation", { startupContinuation: true }).catch(error => {
    managerOperationalLog.record("warn", "plugin_post_ready_activation_failed", {
      result: "Required Manager control plane remains live",
      error: managerOperationalError(error, rootDir)
    });
  }).finally(() => { startupRequiredGenerationId = undefined; });
  // Publish the fenced control plane before any NAS recovery worker can start.
  setImmediate(() => {
    if (managerRuntimeOwner.isTearingDown()) return;
    void startOptionalSourcePatchWatcher();
    refreshStartupPresentation();
    void startLanDiscovery().catch(error => {
      managerOperationalLog.record("warn", "manager_lan_discovery_failed", {
        error: managerOperationalError(error, rootDir)
      });
    });
  });
  if (!managerReadOnly) {
    setImmediate(() => {
      if (managerRuntimeOwner.isTearingDown()) return;
      void allDayRecording.service.restore().catch(error => {
        console.error("All-day recording could not restore its saved intent:", error);
      });
    });
  }
  planStorageStartupLifecycle.start();
  routeCatalogStartupLifecycle.start();
  setImmediate(() => {
    if (!managerRuntimeOwner.isTearingDown()) void dataUpgrades.start().catch(error => {
      managerOperationalLog.record("warn", "data_upgrade_check_failed", { error: managerOperationalError(error, rootDir) });
    });
  });
  } catch (error) {
    await failManagerStartup("manager_request_startup", error);
  }
  } catch (error) {
    if (managerRuntimeOwner.isTearingDown()) throw error;
    await failManagerStartup("manager_runtime_construction", error);
  }
}



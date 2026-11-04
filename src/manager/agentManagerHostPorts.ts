import type { AgentAdapterDescriptor, AgentAdapterInvocation } from "@rabiroute/plugin-sdk";
import type { ApiOperationDefinition, ApiOperationRegistration } from "./apiOperationContract.js";
import type { AgentScanRuntimeSnapshot } from "../agentAdapters/managerTypes.js";
import type { AgentAdapterCatalogWorkerTask } from "./agentAdapterCatalogWorker.js";
import type { DeviceAgentOwnerOptions } from "../agentAdapters/deviceAgentOwner.js";
import type { DeviceAgentEndpointBridgeOptions } from "./deviceAgentEndpointBridge.js";

export type AgentManagerHostPorts = Readonly<{
  rootDir: string;
  packageRoot: string;
  readOnly(): boolean;
  managerInstanceId(): string;
  getRuntimes(): Iterable<AgentScanRuntimeSnapshot>;
  publishManagerEvent(type: string, data: unknown): void;
  deliveryReceiptChanged(): void;
  registerOperations(instanceId: string, definitions: readonly ApiOperationDefinition[], signal: AbortSignal): Promise<ApiOperationRegistration>;
  runScan(task: AgentAdapterCatalogWorkerTask, invocation?: AgentAdapterInvocation): Promise<Record<string, unknown>>;
  deviceContext?(): {
    key: string;
    ownerOptions: DeviceAgentOwnerOptions;
    endpointOptions: Omit<DeviceAgentEndpointBridgeOptions, "owner">;
  };
}>;
export type AgentManagerImplementationOptions = Readonly<{
  manifest: AgentAdapterDescriptor;
  capability: string;
  scannerEntry: string;
  scannerExport?: string;
  runtimeLayout?: Readonly<{ packageRoot: string; stateRoot: string }>;
  host: AgentManagerHostPorts;
}>;

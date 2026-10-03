import type { KnowledgeInvokeOptions, KnowledgeManagerReceipt } from '../../../packages/rabi-knowledge-contract/tools.mjs';
export type LocalManagerEndpoint = { managerUrl: string; meta: Record<string, unknown> };
export function createManagerClient(options: {
  managerUrl: string; localHost: true; timeoutMs?: number; fetchImpl?: typeof fetch;
  endpointSession: { ensure(options?: { diagnostic?: boolean; forceDiscovery?: boolean }): Promise<LocalManagerEndpoint> };
}): { invoke(method: string, target: string, options?: KnowledgeInvokeOptions): Promise<KnowledgeManagerReceipt> };

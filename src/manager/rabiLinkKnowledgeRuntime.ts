import { validateKnowledgeArguments } from '../../packages/rabi-knowledge-contract/schema.mjs';
import { knowledgeToolIsMutation } from '../../packages/rabi-knowledge-contract/tools.mjs';
import { createRabiLinkKnowledgeBridge, type KnowledgeDeviceMetadata } from './rabiLinkKnowledgeBridge.js';
import { createDirectKnowledgeAdapter, type KnowledgeRuntimeContext } from './rabiLinkKnowledgeDirect.js';
export type { KnowledgeRuntimeContext } from './rabiLinkKnowledgeDirect.js';

export const KNOWLEDGE_PATH = '/__rabilink/knowledge';
export type KnowledgeQueueMetadata = KnowledgeDeviceMetadata;
export const isCanonicalKnowledgeDeviceId = (value: string) => /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u.test(value) && !value.includes('--');

export async function executeKnowledgeQueue(context: KnowledgeRuntimeContext | undefined, targetDeviceId: string, metadata: KnowledgeQueueMetadata | undefined, request: unknown, nonReplayable: boolean) {
  if (!isCanonicalKnowledgeDeviceId(targetDeviceId)) throw new Error('KNOWLEDGE_CANONICAL_DEVICE_REQUIRED');
  if (!context || !metadata || metadata.targetDeviceId !== targetDeviceId) throw new Error('KNOWLEDGE_DEVICE_DENIED');
  const value = request as { operation?: unknown; name?: unknown; args?: Record<string, unknown> };
  const mutation = value?.operation === 'call' && knowledgeToolIsMutation(String(value.name), value.args);
  if (mutation && nonReplayable !== true) throw new Error('KNOWLEDGE_NONREPLAYABLE_REQUIRED');
  const roleIds = [...new Set(context.roleIds())];
  const adapter = createDirectKnowledgeAdapter(context, roleIds);
  const result = await createRabiLinkKnowledgeBridge(roleIds, { validate: validateKnowledgeArguments, request: adapter.request }).execute(metadata, request);
  if (value?.operation !== 'list') return result;
  const catalog = result as { tools: Array<{ inputSchema?: { properties?: Record<string, unknown> } }> };
  for (const tool of catalog.tools) if (tool.inputSchema?.properties) tool.inputSchema.properties.roleId = { type: 'string', enum: roleIds };
  return { ...catalog, allowedRoles: roleIds, allowWrites: true };
}

export async function probeKnowledgeBridge(context?: KnowledgeRuntimeContext, signal?: AbortSignal): Promise<boolean> {
  if (!context) return false;
  try {
    const adapter = createDirectKnowledgeAdapter(context, context.roleIds());
    await adapter.probe(signal);
    return true;
  } catch { return false; }
}

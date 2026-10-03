import type { KnowledgeSchema } from './schema.mjs';
export { validateKnowledgeArguments } from './schema.mjs';
export type KnowledgeManagerReceipt = {
  statusCode?: number; ok?: boolean; body?: unknown; headers?: Record<string, string>;
  uncertain?: boolean; identityChanged?: boolean;
};
export type KnowledgeInvokeOptions = { replaySafe?: boolean; headers?: Record<string, string>; body?: unknown };
export type KnowledgeTool = { name: string; description: string; inputSchema: KnowledgeSchema; readOnly: boolean };
export type KnowledgeReceipt = { ok: boolean; statusCode: number; uncertain: boolean; [key: string]: unknown };
export function knowledgeToolIsMutation(name: string, args?: Record<string, unknown>): boolean;
export function createKnowledgeTools(options: {
  client: { invoke(method: string, target: string, options?: KnowledgeInvokeOptions): Promise<KnowledgeManagerReceipt> };
  allowedRoles: readonly string[]; allowWrites?: boolean;
}): { list(): KnowledgeTool[]; call(name: string, args: Record<string, unknown>): Promise<KnowledgeReceipt> };

/** Pure JSON schema subset shared by the MCP server and PC bridge. */
export interface KnowledgeSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  enum?: readonly unknown[];
  properties?: Record<string, KnowledgeSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: KnowledgeSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
export type KnowledgeOperation = 'knowledge_search' | 'plan_list' | 'plan_get' | 'plan_statuses' | 'memory_list' | 'memory_get' | 'plan_create' | 'plan_update' | 'recent_memory_create' | 'recent_memory_update';
export const definitions: Record<KnowledgeOperation, KnowledgeSchema>;
/** Throws TypeError for values outside this schema subset. */
export function validate(value: unknown, schema: KnowledgeSchema, label?: string): void;
/** Schema validation only; authorization and Manager semantic checks remain separate. */
export function validateKnowledgeArguments(name: string, args: unknown): void;

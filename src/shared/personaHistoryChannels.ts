import type { PersonaChatReply } from './personaChatHistory.js';
import type { HistoryQqRoute } from './qqConversationHistory.js';

export const CHAT_HISTORY_CATEGORIES = ['agent', 'panel', 'replies', 'aiui'] as const;
export type ChatHistoryCategory = typeof CHAT_HISTORY_CATEGORIES[number];
export function chatHistoryCategory(record: Pick<PersonaChatReply, 'kind'>): ChatHistoryCategory {
  if (record.kind === 'agent_delivery') return 'agent';
  if (record.kind === 'user_delivery') return 'panel';
  if (record.kind === 'aiui_user' || record.kind === 'aiui_assistant') return 'aiui';
  return 'replies';
}
export type MessageHistoryChannelCatalog = { adapters: string[]; chatCategories: ChatHistoryCategory[]; qqRoutes?: HistoryQqRoute[] };

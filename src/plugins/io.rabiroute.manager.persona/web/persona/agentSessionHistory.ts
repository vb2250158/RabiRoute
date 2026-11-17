import { agentMessageText, agentMessageTime as timestamp, codexVisibleMessage } from '@shared/agentSessionMessages';

export type AgentSessionMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: string;
};
export type AgentHistoryEvent = AgentSessionMessage & {
  sequence: number;
  turn?: number;
  completed?: boolean;
  boundary?: boolean;
  stream?: string;
};
type JsonRecord = Record<string, any>;
function object(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
/** Keep only user messages, final text and DSH turn boundaries from native pages. */
export function agentHistoryEvents(provider: string, page: JsonRecord): AgentHistoryEvent[] {
  if (provider === 'codex') {
    return (page.entries ?? []).flatMap((entry: unknown) => {
      const row = object(entry), record = object(row.record);
      const sequence = Number(row.sequence);
      const visible = codexVisibleMessage(record);
      if (!visible || !visible.text.trim() || !Number.isSafeInteger(sequence)) return [];
      const {role,text} = visible;
      return [{ id: `codex:${sequence}`, role, text, sequence, stream: record.type, time: timestamp(record.timestamp) }];
    });
  }
  if (provider === 'workbuddy') {
    return (page.entries ?? []).flatMap((entry:unknown) => {
      const row = object(entry), record = object(row.record), sequence = Number(row.sequence);
      if (!Number.isSafeInteger(sequence) || record.type !== 'message' || !['user','assistant'].includes(record.role)) return [];
      const text = agentMessageText(record.content);
      if (!text.trim()) return [];
      return [{id:`workbuddy:${sequence}`,role:record.role,text,sequence,time:timestamp(record.timestamp)}];
    });
  }
  if (provider === 'dsh') {
    return (page.records ?? []).flatMap((entry: unknown) => {
      const event = object(object(entry).event), data = object(event.data);
      const sequence = Number(event.seq), time = timestamp(event.time);
      if (!Number.isSafeInteger(sequence)) return [];
      if (event.type === 'turn/end') return [{ id: `dsh:${sequence}`, role: 'assistant', text: '', time,
        sequence, turn: data.turn, boundary: true, completed: object(data.reason).kind === 'completed' }];
      const user = event.type === 'user/message';
      if (!user && event.type !== 'assistant/message') return [];
      const message = user ? data : object(data.message);
      if (user && object(message.source).kind !== 'user') return [];
      const text = agentMessageText(message.content);
      if (user && !text.trim() || data.interrupted) return [];
      return [{ id: `dsh:${sequence}`, role: user ? 'user' : 'assistant', text, time, sequence,
        ...(!user ? { turn: data.turn } : {}) }];
    });
  }
  return [];
}

export function agentHistoryMessages(provider: string, events: readonly AgentHistoryEvent[]): AgentSessionMessage[] {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const completed = new Set(ordered.filter(event => event.boundary && event.completed).map(event => event.turn));
  const finalByTurn = new Map<number | undefined, string>();
  if (provider === 'dsh') {
    for (const event of ordered) {
      if (!event.boundary && event.role === 'assistant' && completed.has(event.turn)) finalByTurn.set(event.turn, event.id);
    }
  }
  const messages: AgentSessionMessage[] = [];
  let previousEvent: AgentHistoryEvent | undefined;
  for (const event of ordered) {
    if (event.boundary || provider === 'dsh' && event.role === 'assistant' && finalByTurn.get(event.turn) !== event.id) continue;
    if (!event.text.trim()) continue;
    const previous = messages.at(-1);
    // Codex records the same user/final message in both its event and response streams.
    if (provider === 'codex' && previousEvent?.stream !== event.stream && previous?.role === event.role && previous.text === event.text) continue;
    messages.push({ id: event.id, role: event.role, text: event.text, time: event.time });
    previousEvent = event;
  }
  return messages;
}

export function agentHistoryNextCursor(provider: string, page: JsonRecord): string | null {
  if (provider === 'codex' || provider === 'workbuddy') return page.nextCursor ?? null;
  if (provider === 'dsh' && page.hasMore) {
    const sequences = (page.records ?? []).map((row: unknown) => object(object(row).event).seq).filter(Number.isSafeInteger);
    if (!sequences.length) throw new Error('历史分页未返回下一页位置。');
    return String(Math.min(...sequences));
  }
  return null;
}

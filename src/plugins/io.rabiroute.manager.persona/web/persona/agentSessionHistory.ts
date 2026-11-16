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
function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    const item = object(part);
    if (['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string') return item.text;
    if (['image', 'input_image'].includes(item.type)) return '[图片]';
    return '';
  }).filter(Boolean).join('\n');
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** Keep only user messages, final text and DSH turn boundaries from native pages. */
export function agentHistoryEvents(provider: string, page: JsonRecord): AgentHistoryEvent[] {
  if (provider === 'codex') {
    return (page.entries ?? []).flatMap((entry: unknown) => {
      const row = object(entry), record = object(row.record), payload = object(record.payload);
      const sequence = Number(row.sequence);
      let role: AgentSessionMessage['role'] | undefined, text = '';
      if (record.type === 'event_msg' && payload.type === 'user_message') {
        role = 'user'; text = typeof payload.message === 'string' ? payload.message : '';
      } else if (record.type === 'event_msg' && payload.type === 'task_complete') {
        role = 'assistant'; text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      } else if (record.type === 'response_item' && payload.type === 'message'
        && (payload.role === 'user' || payload.role === 'assistant' && payload.phase === 'final_answer')) {
        role = payload.role; text = textContent(payload.content);
      }
      if (!role || !text.trim() || !Number.isSafeInteger(sequence)) return [];
      return [{ id: `codex:${sequence}`, role, text, sequence, stream: record.type, time: timestamp(record.timestamp) }];
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
      const text = textContent(message.content);
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
  if (provider === 'codex') return page.nextCursor ?? null;
  if (provider === 'dsh' && page.hasMore) {
    const sequences = (page.records ?? []).map((row: unknown) => object(object(row).event).seq).filter(Number.isSafeInteger);
    if (!sequences.length) throw new Error('历史分页未返回下一页位置。');
    return String(Math.min(...sequences));
  }
  return null;
}

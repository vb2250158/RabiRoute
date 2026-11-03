import { createHash } from 'node:crypto';
import type { RecentMessageContextQuery } from './messageContextStore.js';

type Position = { sourceOrder: number; position: number; rowid: number };
export function historyPageScope(query: RecentMessageContextQuery, generation: string, layout: string, epoch: string): string {
  return createHash('sha256').update(JSON.stringify([generation, layout, epoch, query.adapter, query.channel, query.kind,
    query.sender, query.target, query.conversationKey, query.query, query.queryMatch, query.includeArchives, query.from, query.to,
    query.afterSequence, query.beforeSequence, query.excludedMessageIds])).digest('hex');
}
export function historyPageCursor(scope: string, position: Position): string {
  return Buffer.from(JSON.stringify({ scope, ...position })).toString('base64url');
}
export function readHistoryPageCursor(cursor: string, scope: string): Position {
  let value: Position & { scope: string };
  try {
    if (cursor.length > 1024) throw new Error();
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (![value.sourceOrder, value.position, value.rowid].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error();
  } catch { throw Object.assign(new Error('MESSAGE_HISTORY_CURSOR_INVALID'), { statusCode: 400 }); }
  if (value.scope !== scope) throw Object.assign(new Error('MESSAGE_HISTORY_CURSOR_EXPIRED: refresh this channel.'), { statusCode: 409 });
  return value;
}

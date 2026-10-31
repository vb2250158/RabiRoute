import type { PersonaChatHistoryPage, PersonaChatReply } from "@shared/personaChatHistory";

export type ChatHistoryAddition = PersonaChatHistoryPage & {
  /** A gap is still present; resume here before declaring the refresh complete. */
  continuationCursor: number | null;
};

/** Read one bounded batch, retaining the exact backward cursor for a reconnect gap. */
export async function readChatHistoryAddition(
  known: ReadonlySet<string>,
  readPage: (cursor?: number) => Promise<PersonaChatHistoryPage>,
  options: { cursor?: number; maxPages?: number } = {}
): Promise<ChatHistoryAddition> {
  const entries: PersonaChatReply[] = [];
  const seen = new Set<string>();
  const maxPages = options.maxPages ?? 3;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be a positive integer.");
  let cursor = options.cursor;
  const metadata: Pick<PersonaChatHistoryPage, "newerCursor" | "invalidRecords"> = {};
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await readPage(cursor);
    if (pages === 0) metadata.newerCursor = page.newerCursor;
    metadata.invalidRecords = (metadata.invalidRecords ?? 0) + (page.invalidRecords ?? 0);
    for (const entry of page.entries) {
      if (known.has(entry.id)) return { ...metadata, entries, nextCursor: page.nextCursor, continuationCursor: null };
      if (!seen.has(entry.id)) { seen.add(entry.id); entries.push(entry); }
    }
    if (!known.size || page.nextCursor === null) return { ...metadata, entries, nextCursor: page.nextCursor, continuationCursor: null };
    // The server contract is an exclusive byte offset; equality or increase is invalid,
    // including across batches where a local visited-cursor set would not help.
    if (cursor !== undefined && page.nextCursor >= cursor) throw new Error("Chat history cursor did not advance.");
    cursor = page.nextCursor;
  }
  return { ...metadata, entries, nextCursor: cursor!, continuationCursor: cursor! };
}
/** Merge a server-ordered batch at its scan frontier, including already displayed islands. */
export function mergeChatHistoryBatch(
  current: readonly PersonaChatReply[],
  batch: readonly PersonaChatReply[],
  afterId?: string
): PersonaChatReply[] {
  const incoming = new Set(batch.map(entry => entry.id));
  const remaining = current.filter(entry => !incoming.has(entry.id));
  const index = afterId === undefined ? 0 : remaining.findIndex(entry => entry.id === afterId) + 1;
  return [...remaining.slice(0, index), ...batch, ...remaining.slice(index)];
}

/** Four 50-row pages bound display memory; discarded rows are recoverable by byte cursor. */
export function retainChatHistoryWindow(entries: readonly PersonaChatReply[], anchorId?: string, older = false, limit = 200) {
  const anchor = anchorId ? entries.findIndex(entry => entry.id === anchorId) : -1;
  const start = Math.max(0, Math.min(entries.length - limit, anchor >= 0 ? anchor - 50 : older ? entries.length - limit : 0));
  return { entries: entries.slice(start, start + limit), trimmedNewer: start > 0, trimmedOlder: start + limit < entries.length };
}

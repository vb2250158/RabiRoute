import { rememberMessageHistoryAppend, type MessageHistoryAppendCommit } from "./messageHistorySourceVersion.js";

const listeners = new Set<(directory: string) => void>();

export function subscribeMessageHistoryChanges(listener: (directory: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A wake-up hint only: durable source fingerprints recover missed notifications. */
export function publishMessageHistoryChange(directory: string, commit?: MessageHistoryAppendCommit): void {
  if (commit) rememberMessageHistoryAppend(directory, commit);
  for (const listener of listeners) {
    try { listener(directory); }
    catch { process.emitWarning("Message history index notification failed; source reconciliation remains available."); }
  }
}

import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  submitWorkbuddyDesktopComposer, WorkbuddyDesktopSubmissionDeclined, type WorkbuddyDesktopComposerPort
} from "./workbuddyDesktopComposer.js";
import { readWorkbuddyDesktopCreationReceipt, snapshotWorkbuddyDesktopIds } from "./workbuddyDesktopCreationReceipt.js";
import { normalizeWorkbuddyWorkspace } from "./workbuddySessionStore.js";

export type WorkbuddyDesktopCreationInput = { intentId: string; title: string; workspace: string; workspaceLabel: string; prompt: string };
export type WorkbuddyDesktopCreationResult =
  | { state: "created"; thread: { id: string; title: string; cwd: string }; sequence: number; intentId: string }
  | { state: "pending"; intentId: string }
  | { state: "conflict"; intentId: string; threadIds?: string[] };

type Intent = { digest: string; marker: string; existingIds: string[]; workspace: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function readIntent(file: string): Promise<Intent | null> {
  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as Partial<Intent>;
    if (typeof entry.digest !== "string" || typeof entry.marker !== "string" || !entry.marker.startsWith("RABI_WB_CREATE_")
      || !Array.isArray(entry.existingIds) || !entry.existingIds.every(id => typeof id === "string") || typeof entry.workspace !== "string") {
      throw new Error("WorkBuddy 原创建记录无法校验，请保留原编号。");
    }
    return entry as Intent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function armIntent(file: string, entry: Intent): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(entry), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** One local desktop owner serializes UI actions and persists intent before send. */
export function createWorkbuddyDesktopCreator(port: WorkbuddyDesktopComposerPort, journalDir: string) {
  let queue: Promise<unknown> = Promise.resolve();
  return function create(input: WorkbuddyDesktopCreationInput, signal?: AbortSignal): Promise<WorkbuddyDesktopCreationResult> {
    const result = queue.then(async (): Promise<WorkbuddyDesktopCreationResult> => {
      signal?.throwIfAborted();
      const workspace = normalizeWorkbuddyWorkspace(input.workspace);
      const intentId = input.intentId.trim();
      if (!workspace || !intentId || !input.title.trim() || !input.workspaceLabel.trim() || !input.prompt.trim()) {
        throw new Error("创建 WorkBuddy 聊天需要原创建编号、标题、工作区和首条消息。");
      }
      const filename = path.join(journalDir, `${hash(intentId)}.json`);
      const digest = hash(JSON.stringify([workspace, input.workspaceLabel.trim(), input.title.trim(), input.prompt]));
      const pending = { state: "pending", intentId } as const;
      const reconcile = async (entry: Intent): Promise<WorkbuddyDesktopCreationResult> => {
        if (entry.digest !== digest) return { state: "conflict", intentId };
        const receipt = await readWorkbuddyDesktopCreationReceipt({
          workspace: entry.workspace, marker: entry.marker, existingIds: entry.existingIds, signal
        });
        return receipt.state === "not_observed" ? pending : { ...receipt, intentId };
      };
      const previous = await readIntent(filename);
      if (previous) return reconcile(previous);

      await mkdir(journalDir, { recursive: true });
      const marker = `RABI_WB_CREATE_${hash(intentId)}`;
      const entry = { digest, marker, workspace, existingIds: snapshotWorkbuddyDesktopIds() };
      let armed = false;
      try {
        await submitWorkbuddyDesktopComposer(port, {
          workspace: input.workspace,
          prompt: `${input.prompt}\n\n[WorkBuddy 创建编号] ${marker}`,
          signal,
          beforeSubmit: async () => {
            await armIntent(filename, entry);
            armed = true;
            signal?.throwIfAborted();
          }
        });
      } catch (error) {
        if (armed && error instanceof WorkbuddyDesktopSubmissionDeclined) {
          // The renderer explicitly returned before clicking Send. A transport
          // failure cannot establish that and must leave the intent in place.
          try {
            await unlink(filename);
          } catch {
            return pending;
          }
          throw error;
        }
        if (armed) return pending;
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const winner = await readIntent(filename);
          if (winner) return reconcile(winner);
        }
        throw error;
      } finally {
        await port.disableRendererFocus?.().catch(() => undefined);
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        if (signal?.aborted) return pending;
        const receipt = await reconcile(entry);
        if (receipt.state !== "pending") return receipt;
        await delay(400);
      }
      return pending;
    });
    queue = result.catch(() => undefined);
    return result;
  };
}

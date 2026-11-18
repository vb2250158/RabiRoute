import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFileSync, withFileLockSync } from "@rabiroute/host-api/shared/filePersistence";
import { createLocalSecretProtector } from "@rabiroute/host-api/shared/localSecretProtection";
import type { BotCredentials } from "./protocol.js";

export type AccountSnapshot = {
  id: string; appId: string; sandbox: boolean; revision: string;
  state: "connected" | "authorization_required"; checkedAt?: string;
};
type AccountRow = Omit<AccountSnapshot, "state"> & { ciphertext?: string; lastRequestId: string };

export class AccountConflict extends Error {}

export function createBotAccounts(stateRoot: string) {
  const directory = path.join(stateRoot, "data", ".runtime", "qqbot");
  const file = path.join(directory, "accounts.json");
  const protector = createLocalSecretProtector(directory);
  const cache = new Map<string, { revision: string; appSecret: string }>();
  function readRows(): AccountRow[] {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  function snapshot({ id, appId, sandbox, revision, ciphertext, checkedAt }: AccountRow): AccountSnapshot {
    return { id, appId, sandbox, revision, state: ciphertext ? "connected" : "authorization_required", checkedAt };
  }
  return {
    list: () => readRows().map(snapshot),
    observe(listener: () => void) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const watcher = fs.watch(directory, { persistent: false }, (_, name) => {
        if (name === "accounts.json" || name == null) listener();
      });
      return () => watcher.close();
    },
    receipt(requestId: string, id?: string) {
      const row = readRows().find(account => account.lastRequestId === requestId);
      if (!row) return;
      if (id && id !== row.id) throw new AccountConflict("原请求编号属于其他机器人账号。");
      return snapshot(row);
    },
    credentials(id: string) {
      const row = readRows().find(account => account.id === id);
      if (!row?.ciphertext) { cache.delete(id); return; }
      let cached = cache.get(id);
      if (cached?.revision !== row.revision) {
        cached = { revision: row.revision, appSecret: protector.unprotect(row.ciphertext) };
        cache.set(id, cached);
      }
      return { id, revision: row.revision, appId: row.appId, sandbox: row.sandbox, appSecret: cached.appSecret };
    },
    update(input: { id?: string; expected?: string; requestId: string; credentials?: BotCredentials; checked?: boolean }) {
      return withFileLockSync(file + ".lock", () => {
        const rows = readRows();
        const repeated = rows.find(account => account.lastRequestId === input.requestId);
        if (repeated && (!input.id || repeated.id === input.id)) return snapshot(repeated);
        const existing = rows.find(account => account.id === input.id);
        if (repeated || (input.id && (!existing || existing.revision !== input.expected))) {
          throw new AccountConflict("机器人账号状态已更新。请刷新账号列表。");
        }
        const credentials = input.credentials;
        const appId = credentials?.appId ?? existing?.appId;
        if (!appId) throw new AccountConflict("QQ 机器人账号缺少 AppID。");
        const sandbox = credentials?.sandbox ?? existing!.sandbox;
        if (rows.some(account => account.appId === appId && account.sandbox === sandbox && account.id !== existing?.id)) {
          throw new AccountConflict("此 AppID 在所选环境已有账号。请选择该账号重新授权。");
        }
        if (existing && existing.appId !== appId) throw new AccountConflict("请为新的 AppID 添加独立账号。");
        const row: AccountRow = {
          id: existing?.id ?? randomUUID(), appId, sandbox,
          revision: input.checked ? existing!.revision : randomUUID(), lastRequestId: input.requestId,
          ...(credentials ? { ciphertext: input.checked ? existing!.ciphertext : protector.protect(credentials.appSecret),
            checkedAt: new Date().toISOString() } : {})
        };
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicWriteFileSync(file, JSON.stringify([...rows.filter(account => account.id !== row.id), row]), { mode: 0o600 });
        cache.delete(row.id);
        return snapshot(row);
      });
    }
  };
}

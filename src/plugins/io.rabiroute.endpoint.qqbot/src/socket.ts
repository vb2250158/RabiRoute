import { setTimeout as delay } from "node:timers/promises";
import type { createBotAccounts } from "./accounts.js";
import { decodeBotDispatch, type createBotApi } from "./protocol.js";

type Account = NonNullable<ReturnType<ReturnType<typeof createBotAccounts>["credentials"]>>;
type SocketOptions = {
  account(): Account | undefined;
  watchAccount(listener: () => void): () => void;
  api: ReturnType<typeof createBotApi>;
  gatewayId: string;
  intents: number;
  signal: AbortSignal;
  accept(record: NonNullable<ReturnType<typeof decodeBotDispatch>>): void;
  report(state: "connecting" | "ready" | "disconnected" | "authorization_required" | "blocked", code?: number): void;
  connect?: (url: string) => WebSocket;
};

type Resume = { revision: string; id?: string; seq?: number };

async function connectOnce(options: SocketOptions, account: Account, session: Resume): Promise<{ code: number; ready: boolean }> {
  const current = () => {
    options.signal.throwIfAborted();
    if (options.account()?.revision !== account.revision) throw new Error("QQ Bot authorization changed.");
  };
  const address = await options.api.invoke(account, account.revision, "GET", "/gateway", undefined, current, options.signal);
  const url = new URL((address.data as { url?: string } | null)?.url ?? "");
  if (address.status >= 300 || url.protocol !== "wss:" || url.username || url.password
    || !(url.hostname === "qq.com" || url.hostname.endsWith(".qq.com"))) throw new Error("QQ Bot gateway rejected.");
  const token = "QQBot " + await options.api.token(account, account.revision);
  current();
  const socket = (options.connect ?? (address => new WebSocket(address)))(url.href);
  socket.binaryType = "arraybuffer";
  return new Promise(resolve => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let ready = false;
    let awaitingAck = false;
    let finished = false;
    let stopWatching = () => {};
    const send = (op: number, d: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ op, d }));
    };
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(handshake);
      clearInterval(heartbeat);
      stopWatching();
      options.signal.removeEventListener("abort", abort);
      if (socket.readyState < 2) socket.close();
      resolve({ code, ready });
    };
    const abort = () => finish(1000);
    const handshake = setTimeout(() => finish(4009), 30000);
    try {
      stopWatching = options.watchAccount(() => {
        try { current(); } catch { finish(4004); }
      });
    } catch { finish(1006); return; }
    options.signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("close", event => finish(event.code));
    socket.addEventListener("error", () => finish(1006));
    if (options.signal.aborted) { abort(); return; }
    socket.addEventListener("message", event => {
      if (finished) return;
      const raw = typeof event.data === "string" ? event.data
        : event.data instanceof ArrayBuffer ? Buffer.from(event.data).toString("utf8") : "";
      if (!raw || Buffer.byteLength(raw) > 1024 * 1024) return;
      let payload;
      try { payload = JSON.parse(raw); } catch { return; }
      if (!payload || typeof payload !== "object") return;
      if (Number.isSafeInteger(payload.s)) session.seq = payload.s;
      switch (payload.op) {
        case 10: {
          const interval = payload.d?.heartbeat_interval;
          if (!Number.isFinite(interval) || interval < 100 || interval > 300000 || heartbeat) { finish(4009); return; }
          if (session.id && session.seq !== undefined) {
            send(6, { token, session_id: session.id, seq: session.seq });
          } else {
            send(2, { token, intents: options.intents, shard: [0, 1], properties: { "\$os": process.platform, "\$browser": "RabiRoute", "\$device": "RabiRoute" } });
          }
          // event-driven-allow: transport heartbeat keepalive
          heartbeat = setInterval(() => {
            if (awaitingAck) { finish(4009); return; }
            awaitingAck = true;
            send(1, session.seq ?? null);
          }, interval);
          break;
        }
        case 11: awaitingAck = false; break;
        case 1: send(1, session.seq ?? null); break;
        case 7: finish(1001); break;
        case 9: finish(payload.d === true ? 1001 : 4007); break;
        case 0: {
          if (payload.t === "READY" || payload.t === "RESUMED") {
            if (payload.t === "READY") session.id = typeof payload.d?.session_id === "string" ? payload.d.session_id : undefined;
            ready = true;
            clearTimeout(handshake);
            options.report("ready");
          } else if (ready) {
            try {
              current();
              const record = decodeBotDispatch(payload, account, options.gatewayId, Date.now());
              if (record) options.accept(record);
            } catch { finish(4004); }
          }
        }
      }
    });
  });
}

function waitForAccountChange(options: SocketOptions, revision: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unwatch();
      options.signal.removeEventListener("abort", finish);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const changed = () => {
      try {
        if (options.signal.aborted || options.account()?.revision !== revision) finish();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const unwatch = options.watchAccount(changed);
    options.signal.addEventListener("abort", finish, { once: true });
    changed();
  });
}

export async function runBotSocket(options: SocketOptions): Promise<void> {
  const intervals = [1000, 2000, 5000, 10000, 30000, 60000];
  let session: Resume | undefined;
  let failures = 0;
  let blocked = "";
  while (!options.signal.aborted) {
    const account = options.account();
    if (!account || blocked === account.revision) {
      if (!account) options.report("authorization_required");
      await waitForAccountChange(options, account?.revision);
      continue;
    }
    if (session?.revision !== account.revision) { session = { revision: account.revision }; failures = 0; }
    options.report("connecting");
    const connection = await connectOnce(options, account, session).catch(() => ({ code: 1006, ready: false }));
    if (options.signal.aborted) return;
    const code = connection.code;
    if ([4013, 4014, 4914, 4915].includes(code)) {
      blocked = account.revision;
      options.report("blocked", code);
      continue;
    }
    if ([4004, 4006, 4007, 4009].includes(code) || (code >= 4900 && code <= 4913)) {
      session = { revision: account.revision };
      if (code === 4004) options.api.invalidateToken(account, account.revision);
    }
    options.report("disconnected", code);
    if (connection.ready) failures = 0;
    const wait = code === 4008 ? 60000 : intervals[Math.min(failures++, intervals.length - 1)];
    await delay(wait, undefined, { signal: options.signal }).catch(() => {});
  }
}

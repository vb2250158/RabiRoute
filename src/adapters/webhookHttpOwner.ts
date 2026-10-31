import type http from "node:http";
import type { VoiceTranscriptEventRecord } from "../history.js";
import type { WebhookAdapterProfile, WebhookPayload } from "./webhookAdapter.js";

export type WebhookHttpReply = Readonly<{
  statusCode: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;

export type WebhookHttpOwnerContext = Readonly<{
  profile: WebhookAdapterProfile;
  webhookPath: string;
  accepting(): boolean;
  acceptPayload(payload: WebhookPayload, bodyBytes: number): VoiceTranscriptEventRecord;
  acceptedResponse?(record: VoiceTranscriptEventRecord, payload: WebhookPayload): WebhookHttpReply;
  readReplies?(url: URL): Record<string, unknown>;
  reportError(message: string): void;
  reportRejected(method: string | undefined, url: string | undefined): void;
}>;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

/** Preserve the adapter's native codec: replacement UTF-8, arbitrary content type and a destroyed oversized request. */
export function readNativeWebhookBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size > 1024 * 1024) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** The original business owners are injected; this module owns only their native HTTP input and reply semantics. */
export function createWebhookHttpOwner(context: WebhookHttpOwnerContext) {
  const stopping = (): WebhookHttpReply => ({ statusCode: 503,
    headers: { "content-type": "text/plain; charset=utf-8" }, body: `${context.profile.label} is stopping.` });
  return {
    ready(): WebhookHttpReply {
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true,
        adapterType: context.profile.type, label: context.profile.label, path: context.webhookPath,
        port: context.profile.port, status: "ready" }) };
    },
    replies(url: URL): WebhookHttpReply {
      if (!context.readReplies) throw new Error("This webhook profile has no replies owner.");
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(context.readReplies(url)) };
    },
    async message(request: http.IncomingMessage): Promise<WebhookHttpReply> {
      try {
        const body = await readNativeWebhookBody(request);
        if (!context.accepting()) return stopping();
        const payload = JSON.parse(body || "{}") as WebhookPayload;
        const record = context.acceptPayload(payload, Buffer.byteLength(body));
        return context.acceptedResponse?.(record, payload) ?? { statusCode: 204 };
      } catch (error) {
        if (!context.accepting()) return stopping();
        const message = error instanceof Error ? error.message : String(error);
        context.reportError(message);
        return { statusCode: 500, body: message };
      }
    },
    rejected(request: http.IncomingMessage): WebhookHttpReply {
      context.reportRejected(request.method, request.url);
      return { statusCode: 404 };
    },
    stopping
  };
}

/** A listener's accepted callbacks remain owned until their actual promises finish, including after socket close. */
export function createWebhookRequestProducer(server: http.Server) {
  let accepting = true;
  let closeFlight: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const track = (operation: () => Promise<void>): Promise<void> => {
    const work = Promise.resolve().then(operation);
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  return {
    accepting: () => accepting,
    track,
    run(operation: () => Promise<void>, response: http.ServerResponse): void {
      void track(operation).catch(error => {
        if (!response.destroyed && !response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
      });
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight;
      accepting = false;
      closeFlight = (async () => {
        const closed = !server.listening ? Promise.resolve() : new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
        server.closeAllConnections();
        try { await closed; }
        finally { await Promise.allSettled([...pending]); }
      })();
      return closeFlight;
    },
    activeRequestCount: () => pending.size
  };
}

import type http from "node:http";
import { Readable, Writable } from "node:stream";
import { stickySpeechAuthority, awaitSpeechAuthority, type SpeechAuthorityGuard } from "./speechRequestAuthority.js";

export interface SpeechEventProxyOptions {
  openUpstream: (signal: AbortSignal) => Promise<Response>;
  errorMessage?: (error: unknown) => string;
  guard?: SpeechAuthorityGuard;
}

function writeJsonError(response: http.ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ code: -1, message }), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength)
  });
  response.end(body);
}

/** One request owns the upstream abort signal and every published SSE chunk. */
export function proxySpeechEventStream(response: http.ServerResponse, options: SpeechEventProxyOptions): void {
  const controller = new AbortController();
  const guard = stickySpeechAuthority(options.guard);
  response.once("close", () => controller.abort());
  void awaitSpeechAuthority(guard, () => options.openUpstream(controller.signal))
    .then(upstream => {
      guard();
      if (controller.signal.aborted || response.destroyed) return;
      if (!upstream.ok || !upstream.body) {
        writeJsonError(response, upstream.status || 502, "RabiSpeech event stream is unavailable.");
        controller.abort();
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("text/event-stream")) {
        writeJsonError(response, 502, "RabiSpeech event endpoint did not return an SSE stream.");
        controller.abort();
        return;
      }
      guard();
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      const fence = new Writable({
        write(chunk, _encoding, callback) {
          try {
            guard();
            response.write(chunk, callback);
          } catch {
            controller.abort();
            callback(new Error("Speech request authority is no longer current."));
          }
        },
        final(callback) {
          try { guard(); response.end(); callback(); }
          catch { controller.abort(); callback(new Error("Speech request authority is no longer current.")); }
        }
      });
      const stop = () => {
        controller.abort();
        if (!source.destroyed) source.destroy();
        if (!fence.destroyed) fence.destroy();
      };
      const streamError = () => { stop(); if (!response.destroyed) response.destroy(); };
      source.once("error", streamError);
      fence.once("error", streamError);
      response.once("close", stop);
      source.pipe(fence);
    })
    .catch(error => {
      if (response.destroyed || response.writableEnded) return;
      try { guard(); } catch {
        controller.abort();
        if (response.headersSent) response.destroy();
        else writeJsonError(response, 403, "Speech request authority is no longer current.");
        return;
      }
      if (controller.signal.aborted) return;
      const message = options.errorMessage?.(error) || (error instanceof Error ? error.message : String(error));
      try { guard(); } catch {
        controller.abort();
        if (response.headersSent) response.destroy();
        else writeJsonError(response, 403, "Speech request authority is no longer current.");
        return;
      }
      writeJsonError(response, 502, message);
      controller.abort();
    });
}

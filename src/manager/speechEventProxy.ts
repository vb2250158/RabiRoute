import type http from "node:http";
import { Readable } from "node:stream";

export interface SpeechEventProxyOptions {
  openUpstream: (signal: AbortSignal) => Promise<Response>;
  errorMessage?: (error: unknown) => string;
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

/**
 * Own the lifetime boundary between one Manager SSE client and one RabiSpeech
 * upstream stream. Client disconnect aborts exactly that upstream request; the
 * resulting AbortError is a normal terminal event and must never escape as an
 * unhandled Node stream error.
 */
export function proxySpeechEventStream(
  response: http.ServerResponse,
  options: SpeechEventProxyOptions
): void {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  void options.openUpstream(controller.signal)
    .then(upstream => {
      if (controller.signal.aborted || response.destroyed) return;
      if (!upstream.ok || !upstream.body) {
        writeJsonError(response, upstream.status || 502, "RabiSpeech event stream is unavailable.");
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("text/event-stream")) {
        writeJsonError(response, 502, "RabiSpeech event endpoint did not return an SSE stream.");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      source.once("error", error => {
        if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      response.once("close", () => {
        if (!source.destroyed) source.destroy();
      });
      source.pipe(response);
    })
    .catch(error => {
      if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
      writeJsonError(response, 502, options.errorMessage?.(error) || (error instanceof Error ? error.message : String(error)));
    });
}

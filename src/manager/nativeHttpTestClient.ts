import http from "node:http";
import { Readable } from "node:stream";

function requestFixture(input: string | URL, init: RequestInit,
  receive: (response: http.IncomingMessage) => Response | Promise<Response>): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error("Native test HTTP client requires a loopback fixture."));
  }
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
    return Promise.reject(new Error("Native test HTTP client expects a string or byte body."));
  }
  const headers = new Headers(init.headers);
  // Node does not automatically frame a DELETE body; preserve the same bytes that Fetch sends.
  if (body !== undefined && body !== null && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method ?? "GET", headers: Object.fromEntries(headers),
      agent: false, ...(init.signal ? { signal: init.signal } : {}) }, response => {
      try { resolve(receive(response)); }
      catch (error) { response.destroy(); reject(error); }
    });
    request.once("error", reject);
    request.end(body ?? undefined);
  });
}

function responseFor(response: http.IncomingMessage, body: BodyInit | null): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Response(body, { status: response.statusCode ?? 500, statusText: response.statusMessage, headers });
}

function hasBody(response: http.IncomingMessage, init: RequestInit): boolean {
  return init.method !== "HEAD" && ![204, 205, 304].includes(response.statusCode ?? 500);
}

/** Real HTTP fixture transport for OS-assigned loopback ports. These tests exercise
 * server contracts, so browser Fetch forbidden-port policy is not their subject. */
export function nativeHttpTestFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return requestFixture(input, init, response => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", chunk => chunks.push(Buffer.from(chunk)));
    response.once("error", reject);
    response.once("end", () => {
      resolve(responseFor(response, hasBody(response, init) ? Buffer.concat(chunks) : null));
    });
  }));
}

/** Resolve at headers for SSE; cancelling the web stream destroys its original HTTP response. */
export function nativeHttpTestStreamFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return requestFixture(input, init, response => {
    if (!hasBody(response, init)) { response.resume(); return responseFor(response, null); }
    // Node's adapter owns backpressure, premature-close errors and stream cancellation.
    const reader = Readable.toWeb(response).getReader();
    return responseFor(response, new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { reader.releaseLock(); controller.error(error); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); }
      }
    }));
  });
}

import http from "node:http";

/** Real HTTP fixture transport for OS-assigned loopback ports. These tests exercise
 * server contracts, so browser Fetch forbidden-port policy is not their subject. */
export function nativeHttpTestFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error("Native test HTTP client requires a loopback fixture."));
  }
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
    return Promise.reject(new Error("Native test HTTP client expects a string or byte body."));
  }
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)),
      agent: false, ...(init.signal ? { signal: init.signal } : {}) }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else if (value !== undefined) headers.set(key, value);
        }
        const status = response.statusCode ?? 500;
        resolve(new Response(init.method === "HEAD" || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
          { status, statusText: response.statusMessage, headers }));
      });
    });
    request.once("error", reject);
    request.end(body ?? undefined);
  });
}

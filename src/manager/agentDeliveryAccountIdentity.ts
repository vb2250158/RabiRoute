import type { CurrentQqFileBinding } from "./agentDeliveryVerification.js";

const RESPONSE_BYTES = 256 * 1024;
const DEADLINE_MS = 3000;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** One read-only observation using only the trusted binding; no config or account fallback.
 * The optional transport is for isolated tests, not request-supplied transport selection.
 * All failures (including cancellation) return undefined without exposing upstream data.
 */
export async function readQqVerificationAccountIdentity(
  binding: CurrentQqFileBinding,
  signal: AbortSignal,
  transport: typeof fetch = fetch
): Promise<Readonly<{ selfId: string }> | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stop: (() => void) | undefined;
  const abort = () => { controller.abort(); stop?.(); };
  try {
    const { httpUrl, accessToken } = binding.endpoint;
    // Validate the original spelling too: URL normalization must not admit alternate IPs,
    // dot segments, empty query/hash markers, whitespace or credential syntax.
    if (binding.readAllowed !== true || signal.aborted || typeof httpUrl !== "string"
      || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(httpUrl)
      || typeof accessToken !== "string" || /[\x00-\x1f\x7f]/.test(accessToken)) return undefined;
    const origin = new URL(httpUrl);
    if (origin.port && Number(origin.port) > 65535) return undefined;
    const url = `${origin.origin}/get_login_info`;
    const cancelled = new Promise<never>((_, reject) => { stop = () => reject(new Error("Account observation cancelled")); });
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, DEADLINE_MS);
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
    const response = await bounded(transport(url, {
      method: "POST", redirect: "error", cache: "no-store", credentials: "omit", signal: controller.signal,
      headers: { "content-type": "application/json; charset=utf-8", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: "{}"
    }));
    reader = response.body?.getReader();
    const length = response.headers.get("content-length");
    if (!response.ok || response.redirected || (response.url && response.url !== url) || !reader
      || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > RESPONSE_BYTES))) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      bytes += value.byteLength;
      // Bound chunk bookkeeping and empty-chunk streams as well as payload bytes.
      if (bytes > RESPONSE_BYTES || chunks.length >= 4096) return undefined;
      chunks.push(value);
    }
    if (controller.signal.aborted) return undefined;
    const envelope = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown);
    if (envelope?.status !== "ok" || envelope.retcode !== 0) return undefined;
    const id = object(envelope.data)?.user_id;
    const selfId = typeof id === "string" ? id : typeof id === "number" && Number.isSafeInteger(id) ? String(id) : undefined;
    return selfId && /^[1-9][0-9]{0,15}$/.test(selfId) ? { selfId } : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
    // Do not await an untrusted transport's potentially never-settling cancellation.
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

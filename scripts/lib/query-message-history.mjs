import { getTimeoutMs } from "./timeout-settings.mjs";
import { discoverManagerIdentity } from "./discover-manager-url.mjs";

const queryNames = new Set("query match adapter channel kind sender target conversationKey from to afterSequence beforeSequence includeArchives limit maxChars".split(" "));

/** One total budget for discovery, identity verification, search and response parsing; no retries. */
export async function queryMessageHistory({ roleId, query = {}, budgetMs = getTimeoutMs("scripts.history.query",3000), signal, fetch: fetchImpl = fetch, discovery = {} }) {
  if (typeof roleId !== "string" || !roleId.trim()) throw new Error("Message-history roleId is required.");
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 2147483647) throw new Error("Message-history budgetMs must be an integer from 1 to 2147483647.");
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (!queryNames.has(name)) throw new Error("Unsupported message-history query parameter.");
    if (value !== undefined && value !== null) params.set(name,
      name === "includeArchives" && typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const deadlineAt = performance.now() + budgetMs;
  signal?.throwIfAborted();
  const deadline = new AbortController();
  // Keep the deadline alive even when a custom response-body reader owns no handles.
  const timer = setTimeout(() => deadline.abort(new DOMException("Message-history total deadline exceeded.", "TimeoutError")), budgetMs);
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let aborted;
  const interrupted = new Promise((_, reject) => {
    aborted = () => reject(cancellation.reason);
    cancellation.addEventListener("abort", aborted, { once: true });
  });
  const remaining = () => {
    cancellation.throwIfAborted();
    const value = Math.floor(deadlineAt - performance.now());
    if (value < 1) throw new DOMException("Message-history total deadline exceeded.", "TimeoutError");
    return value;
  };
  const request = (async () => {
    const identity = await discoverManagerIdentity({ ...discovery, fetch: fetchImpl, timeoutMs: remaining() });
    params.set("budgetMs", String(remaining()));
    const url = new URL(`/api/roles/${encodeURIComponent(roleId)}/message-endpoint-history`, identity.managerBaseUrl);
    url.search = params.toString();
    const response = await fetchImpl(url, { signal: cancellation, redirect: "error", headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error("Message-history request failed.");
      error.status = response.status;
      error.errorCode = typeof body?.errorCode === "string" ? body.errorCode : "MESSAGE_HISTORY_REQUEST_FAILED";
      throw error;
    }
    return body;
  })();
  try { return await Promise.race([request, interrupted]); }
  finally { clearTimeout(timer); cancellation.removeEventListener("abort", aborted); }
}

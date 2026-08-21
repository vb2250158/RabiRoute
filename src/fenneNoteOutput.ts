export type FenneNoteOutputMode = "reply" | "playback";

export type FenneNoteFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>;

export type FenneNoteOutputOptions = {
  mode: FenneNoteOutputMode;
  url?: string;
  token?: string;
  replyUrl?: string;
  replyToken?: string;
  playbackUrl?: string;
  playbackToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FenneNoteFetch;
};

export type FenneNoteForwardResult = {
  ok: boolean;
  status: number;
  target: string;
  response: unknown;
};

export type FenneNotePostResult = {
  mode: FenneNoteOutputMode;
  status: number;
  target: string;
  response: unknown;
};

const DEFAULT_REPLY_URL = "http://127.0.0.1:8793/api/fennenote/reply";
const DEFAULT_PLAYBACK_URL = "http://127.0.0.1:8793/api/fennenote/playback";
const DEFAULT_TIMEOUT_MS = 30_000;

type FenneNoteHttpResult = FenneNoteForwardResult & {
  mode: FenneNoteOutputMode;
  responseText: string;
  statusText: string;
};

function endpointFor(options: FenneNoteOutputOptions): { target: string; token: string } {
  if (options.mode === "playback") {
    return {
      target: options.url
        ?? options.playbackUrl
        ?? process.env.FENNOTE_PLAYBACK_URL
        ?? DEFAULT_PLAYBACK_URL,
      token: options.token
        ?? options.playbackToken
        ?? process.env.FENNOTE_PLAYBACK_TOKEN
        ?? ""
    };
  }
  return {
    target: options.url
      ?? options.replyUrl
      ?? process.env.FENNOTE_REPLY_URL
      ?? DEFAULT_REPLY_URL,
    token: options.token
      ?? options.replyToken
      ?? process.env.FENNOTE_REPLY_TOKEN
      ?? process.env.FENNOTE_PLAYBACK_TOKEN
      ?? ""
  };
}

function parseResponse(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function requestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!externalSignal && timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timer = timeoutMs > 0
    ? setTimeout(() => {
        controller.abort(new Error(`FenneNote request timed out after ${timeoutMs} ms.`));
      }, timeoutMs)
    : undefined;

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

async function requestFenneNoteOutput(
  body: unknown,
  options: FenneNoteOutputOptions
): Promise<FenneNoteHttpResult> {
  const { target, token } = endpointFor(options);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "RabiRoute"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const timeoutMs = options.timeoutMs ?? 0;
  const { signal, cleanup } = requestSignal(options.signal, timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal
    });
    const responseText = await response.text();
    return {
      mode: options.mode,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      target,
      responseText,
      response: parseResponse(responseText)
    };
  } finally {
    cleanup();
  }
}

/** Manager-facing contract: preserve the endpoint status instead of throwing for non-2xx responses. */
export async function forwardFenneNoteRequest(
  body: unknown,
  options: FenneNoteOutputOptions
): Promise<FenneNoteForwardResult> {
  const result = await requestFenneNoteOutput(body, options);
  return {
    ok: result.ok,
    status: result.status,
    target: result.target,
    response: result.response
  };
}

/** Outbox-facing contract: preserve the previous success shape and throw on non-2xx responses. */
export async function postFenneNoteOutput(
  body: unknown,
  options: FenneNoteOutputOptions
): Promise<FenneNotePostResult> {
  const result = await requestFenneNoteOutput(body, options);
  if (!result.ok) {
    throw new Error(`FenneNote reply endpoint returned ${result.status}: ${result.responseText || result.statusText}`);
  }
  return {
    mode: result.mode,
    status: result.status,
    target: result.target,
    response: result.response
  };
}

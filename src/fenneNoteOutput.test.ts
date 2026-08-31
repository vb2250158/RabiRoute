import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardFenneNoteRequest,
  postFenneNoteOutput,
  type FenneNoteFetch
} from "./fenneNoteOutput.js";

function response(body: string, status = 200, statusText = "OK"): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "content-type": "application/json" }
  });
}

function abortablePendingFetch(): FenneNoteFetch {
  return async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const rejectFromSignal = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) {
      rejectFromSignal();
      return;
    }
    signal?.addEventListener("abort", rejectFromSignal, { once: true });
  });
}

test("Manager forwarding preserves status and parses JSON with reply URL/token overrides", async () => {
  let target = "";
  let init: RequestInit | undefined;
  const fetchImpl: FenneNoteFetch = async (input, requestInit) => {
    target = String(input);
    init = requestInit;
    return response(JSON.stringify({ ok: true, messageId: "reply-1" }), 202, "Accepted");
  };

  const result = await forwardFenneNoteRequest({ text: "hello" }, {
    mode: "reply",
    replyUrl: "http://reply.invalid/default",
    replyToken: "reply-default",
    url: "http://reply.invalid/override",
    token: "reply-override",
    fetchImpl
  });

  assert.deepEqual(result, {
    ok: true,
    status: 202,
    target: "http://reply.invalid/override",
    response: { ok: true, messageId: "reply-1" }
  });
  assert.equal(target, "http://reply.invalid/override");
  assert.equal(init?.method, "POST");
  assert.equal((init?.headers as Record<string, string>).authorization, "Bearer reply-override");
  assert.equal((init?.headers as Record<string, string>)["user-agent"], "RabiRoute");
  assert.equal(init?.body, JSON.stringify({ text: "hello" }));
});

test("Manager forwarding returns non-JSON and non-2xx responses without throwing", async () => {
  const result = await forwardFenneNoteRequest(null, {
    mode: "playback",
    playbackUrl: "http://playback.invalid/request",
    playbackToken: "playback-token",
    fetchImpl: async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer playback-token");
      assert.equal(init?.body, "{}");
      return response("upstream unavailable", 503, "Service Unavailable");
    }
  });

  assert.deepEqual(result, {
    ok: false,
    status: 503,
    target: "http://playback.invalid/request",
    response: { raw: "upstream unavailable" }
  });
});

test("FenneNote forwarding fails closed when an endpoint is not explicitly configured", async () => {
  const previousReply = process.env.FENNOTE_REPLY_URL;
  const previousPlayback = process.env.FENNOTE_PLAYBACK_URL;
  delete process.env.FENNOTE_REPLY_URL;
  delete process.env.FENNOTE_PLAYBACK_URL;
  let fetchCalls = 0;
  const fetchImpl: FenneNoteFetch = async () => {
    fetchCalls += 1;
    return response("{}");
  };
  try {
    await assert.rejects(
      forwardFenneNoteRequest({}, { mode: "reply", url: "  ", replyUrl: "\t", fetchImpl }),
      /FenneNote reply endpoint is not configured; set FENNOTE_REPLY_URL/
    );
    await assert.rejects(
      forwardFenneNoteRequest({}, { mode: "playback", playbackUrl: "  ", fetchImpl }),
      /FenneNote playback endpoint is not configured; set FENNOTE_PLAYBACK_URL/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousReply === undefined) delete process.env.FENNOTE_REPLY_URL;
    else process.env.FENNOTE_REPLY_URL = previousReply;
    if (previousPlayback === undefined) delete process.env.FENNOTE_PLAYBACK_URL;
    else process.env.FENNOTE_PLAYBACK_URL = previousPlayback;
  }
});

test("Outbox forwarding preserves its success result and HTTP error behavior", async () => {
  const success = await postFenneNoteOutput({ text: "play" }, {
    mode: "playback",
    url: "http://playback.invalid/request",
    fetchImpl: async () => response(JSON.stringify({ id: "play-1" }), 200)
  });
  assert.deepEqual(success, {
    mode: "playback",
    status: 200,
    target: "http://playback.invalid/request",
    response: { id: "play-1" }
  });

  await assert.rejects(
    postFenneNoteOutput({ text: "reply" }, {
      mode: "reply",
      url: "http://reply.invalid/request",
      fetchImpl: async () => response("rejected", 409, "Conflict")
    }),
    /FenneNote reply endpoint returned 409: rejected/
  );
});

test("FenneNote forwarding honors an external AbortSignal", async () => {
  const controller = new AbortController();
  const request = forwardFenneNoteRequest({}, {
    mode: "reply",
    url: "http://reply.invalid/request",
    signal: controller.signal,
    timeoutMs: 0,
    fetchImpl: abortablePendingFetch()
  });
  controller.abort(new Error("caller stopped"));
  await assert.rejects(request, /caller stopped/);
});

test("FenneNote forwarding aborts when its timeout expires", async () => {
  await assert.rejects(
    forwardFenneNoteRequest({}, {
      mode: "playback",
      url: "http://playback.invalid/request",
      timeoutMs: 10,
      fetchImpl: abortablePendingFetch()
    }),
    /FenneNote request timed out after 10 ms/
  );
});

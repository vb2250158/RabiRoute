import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("RabiLink Relay Worker preflight permits AIUI bearer auth and mobile PATCH", async () => {
  const moduleUrl = pathToFileURL(path.resolve("scripts/rabilink-relay-cloudflare-worker.mjs")).href;
  const workerModule = await import(moduleUrl) as {
    default: {
      fetch(request: Request, env: Record<string, string>): Promise<Response>;
    };
  };
  const response = await workerModule.default.fetch(new Request(
    "https://relay-worker.example/rokid/rabilink/input",
    {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    },
  ), {});

  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /(?:^|,)PATCH(?:,|$)/);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /(?:^|,)Authorization(?:,|$)/i);

  const originalFetch = globalThis.fetch;
  let forwardedMethod = "";
  let forwardedAuthorization = "";
  let forwardedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    forwardedUrl = String(input);
    forwardedMethod = String(init?.method ?? "");
    forwardedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const proxied = await workerModule.default.fetch(new Request(
      "https://relay-worker.example/api/rabilink/mobile/target?source=test",
      {
        method: "PATCH",
        headers: {
          authorization: "Bearer example-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceId: "pc-example" }),
      },
    ), { RABILINK_UPSTREAM: "https://relay-upstream.example" });

    assert.equal(proxied.status, 200);
    assert.equal(forwardedUrl, "https://relay-upstream.example/api/rabilink/mobile/target?source=test");
    assert.equal(forwardedMethod, "PATCH");
    assert.equal(forwardedAuthorization, "Bearer example-token");
    assert.match(proxied.headers.get("access-control-allow-methods") ?? "", /(?:^|,)PATCH(?:,|$)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

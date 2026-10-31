import assert from "node:assert/strict";
import test from "node:test";
import { createPersonaService } from "../src/persona/personaServiceClient";
import { createPersonaAvatarClient } from "../src/persona/personaAvatarClient";
import { createPersonaVoiceIdentityClient } from "../src/persona/personaVoiceIdentityClient";
import { createPersonaIdentityRelationClient } from "../src/persona/personaIdentityRelationClient";
import { createDesktopPetClient } from "../src/desktopPetClient";

test("persona reads and every write method use the selected PC's full Manager transport", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: 0, data: { binding: {} } }), { headers: { "content-type": "application/json" } });
  };
  const service = createPersonaService("source:a", fetch);
  await createPersonaAvatarClient(service.fetch).upload("same-role", new File(["image"], "avatar.png", { type: "image/png" }));
  await createPersonaAvatarClient(service.fetch).remove("same-role");
  await createPersonaVoiceIdentityClient(service.fetch).identities("same-role");
  await createPersonaVoiceIdentityClient(service.fetch).update("same-role", {} as never);
  await createPersonaIdentityRelationClient(service.fetch).update("same-role", {} as never);
  await createDesktopPetClient(service.fetch).update("same-role", {});
  assert.deepEqual(calls.map(call => call.init?.method || "GET"), ["PUT", "DELETE", "GET", "PUT", "PUT", "PATCH"]);
  assert.ok(calls.every(call => call.url.startsWith("/api/rabilink/peer/http/source%3Aa/manager/api/")));
  assert.ok(calls.every(call => !call.url.includes("/persona/api/")));
  assert.equal(calls[0].init?.headers && (calls[0].init.headers as Record<string, string>)["content-type"], "image/png");
});

test("same-name personas retain independent source identities, cache keys and local request paths", async () => {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async input => { paths.push(String(input)); return new Response("{}"); };
  const a = createPersonaService("a", fetch), b = createPersonaService("b", fetch), local = createPersonaService("", fetch);
  for (const service of [a, b, local]) await service.fetch("/api/roles/same-role/configuration", { method: "PUT", body: "{}" });
  assert.deepEqual(paths, ["/api/rabilink/peer/http/a/manager/api/roles/same-role/configuration", "/api/rabilink/peer/http/b/manager/api/roles/same-role/configuration", "/api/roles/same-role/configuration"]);
  assert.equal(new Set([a.cacheKey("same-role"), b.cacheKey("same-role"), local.cacheKey("same-role")]).size, 3);
  assert.equal(a.path("/meta"), "/api/rabilink/peer/http/a/manager/meta");
  assert.equal(a.path("https://example.com/image.png"), "https://example.com/image.png");
  assert.equal(a.path("/api/rabilink/peer/http/b/manager/meta"), "/api/rabilink/peer/http/b/manager/meta");
});

test("a failed remote write never retries against the local same-name persona", async () => {
  const paths: string[] = [];
  const service = createPersonaService("offline", async input => { paths.push(String(input)); throw new Error("offline"); });
  await assert.rejects(createPersonaAvatarClient(service.fetch).remove("same-role"), /offline/);
  assert.deepEqual(paths, ["/api/rabilink/peer/http/offline/manager/api/roles/same-role/avatar"]);
});

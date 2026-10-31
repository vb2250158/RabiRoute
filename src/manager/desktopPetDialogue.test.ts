import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { readDesktopPetDialogue } from "./desktopPetDialogue.js";
import { DesktopPetOwner } from "./desktopPetRoutes.js";
import { createDesktopPetOperations } from "./desktopPetOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { appendDesktopPetTranscript } from "../desktopPetTranscript.js";

function fixture(context: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pet-dialogue-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeDialogue(root: string, personaId: string, value: unknown): void {
  const directory = path.join(root, personaId, "desktop-pet");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "dialogue.json"), JSON.stringify(value));
}

test("dialogue is persona-owned, missing, invalid and copied configurations stay empty", async context => {
  const root = fixture(context);
  const config = { schemaVersion: 1, personaId: "cat-persona", openers: { watch: "喵，一起看。" } };
  writeDialogue(root, "cat-persona", config);
  writeDialogue(root, "other-persona", config);
  assert.equal((await readDesktopPetDialogue("cat-persona", path.join(root, "cat-persona"))).openers.watch, "喵，一起看。");
  for (const role of ["other-persona", "missing-persona"]) {
    assert.deepEqual(await readDesktopPetDialogue(role, path.join(root, role)), { openers: {}, fallbacks: {} });
  }
  writeDialogue(root, "other-persona", { schemaVersion: 1, personaId: "other-persona", openers: { watch: "  一起看星星。 ", work: 7 }, fallbacks: { companionInterrupted: "稍等一下。" } });
  assert.deepEqual(await readDesktopPetDialogue("other-persona", path.join(root, "other-persona")), {
    openers: { watch: "一起看星星。" }, fallbacks: { companionInterrupted: "稍等一下。" }
  });
  fs.writeFileSync(path.join(root, "other-persona", "desktop-pet", "dialogue.json"), "{");
  assert.deepEqual(await readDesktopPetDialogue("other-persona", path.join(root, "other-persona")), { openers: {}, fallbacks: {} });
});

test("transcripts survive reread, isolate personas and kinds, reject conflicting replay and unsafe identity", context => {
  const root = fixture(context);
  const input = { kind: "asr" as const, id: "../source-id", source: "speech", text: "测试转录", time: 1710000000 };
  assert.equal(appendDesktopPetTranscript("one", path.join(root, "one"), input), true);
  assert.equal(appendDesktopPetTranscript("one", path.join(root, "one"), input), false);
  assert.equal(appendDesktopPetTranscript("two", path.join(root, "two"), input), true);
  assert.equal(appendDesktopPetTranscript("one", path.join(root, "one"), { ...input, kind: "tts" }), true);
  assert.throws(() => appendDesktopPetTranscript("one", path.join(root, "one"), { ...input, text: "changed" }), /different content/);
  assert.throws(() => appendDesktopPetTranscript("../one", root, input), /persona/);
  assert.throws(() => appendDesktopPetTranscript("one", root, { ...input, time: NaN }), /Invalid/);
  const files = fs.readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith(".json"));
  assert.equal(files.length, 3);
  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    assert.equal(record.personaId, file.split(path.sep)[0]);
    assert.equal(record.text, input.text);
    assert.equal(record.id, input.id);
  }
});

test("HTTP dialogue and transcript routes preserve persona identity, method and disk write receipts", async context => {
  const root = fixture(context);
  writeDialogue(root, "one", { schemaVersion: 1, personaId: "one", openers: { work: "一起努力。" } });
  const owner = new DesktopPetOwner({ resolveRoleDir: roleId => path.join(root, roleId), cacheRoot: path.join(root, "cache") });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("dialogue-fixture", createDesktopPetOperations(owner));
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    try { await registration.dispose(); } finally { await owner.stop(); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/desktop-pet/roles`;
  const one = await (await fetch(`${base}/one/dialogue`)).json();
  assert.equal(one.data.dialogue.openers.work, "一起努力。");
  assert.deepEqual((await (await fetch(`${base}/two/dialogue`)).json()).data.dialogue.openers, {});
  assert.equal((await fetch(`${base}/one/dialogue`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/bad%20id/dialogue`)).status, 400);
  const body = { kind: "tts", personaId: "one", voice: "one", id: "play-1", text: "你好", time: 1710000000 };
  const post = (value: unknown) => fetch(`${base}/one/transcripts`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await (await post(body)).json()).data.appended, true);
  assert.equal((await (await post(body)).json()).data.appended, false);
  assert.equal((await post({ ...body, voice: "two" })).status, 400);
  assert.equal((await post({ ...body, personaId: "two" })).status, 400);
  assert.equal((await post({ ...body, text: "conflict" })).status, 400);
  const files = fs.readdirSync(path.join(root, "one", "desktop-pet", "transcripts"), { recursive: true }).map(String);
  assert.equal(files.filter(name => name.endsWith(".json")).length, 1);
  assert.equal(fs.existsSync(path.join(root, "two", "desktop-pet", "transcripts")), false);
});

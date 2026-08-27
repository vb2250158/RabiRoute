import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleDesktopPetApi,
  listDesktopPetPacks,
  type DesktopPetPackCatalog
} from "./desktopPetRoutes.js";
import { DesktopSettingsStore } from "./desktopSettings.js";

function roleFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-pet-"));
}

function writePack(roleDir: string, personaId = "YeYu"): void {
  const packDir = path.join(roleDir, "desktop-pet", "packs", "yeyu-library-default");
  fs.mkdirSync(path.join(packDir, "frames", "thinking"), { recursive: true });
  fs.writeFileSync(path.join(packDir, "idle.gif"), Buffer.from("GIF89a"));
  fs.writeFileSync(path.join(packDir, "frames", "thinking", "thinking_10.png"), Buffer.from("png10"));
  fs.writeFileSync(path.join(packDir, "frames", "thinking", "thinking_2.png"), Buffer.from("png2"));
  fs.writeFileSync(path.join(packDir, "pet-pack.json"), JSON.stringify({
    schemaVersion: 1,
    id: "yeyu-library-default",
    name: "夜雨 · 图书馆日常",
    personaId,
    canvas: { width: 512, height: 512, anchorX: 0.5, anchorY: 0.96 },
    defaults: { fps: 12, scale: 0.5, loop: true },
    states: {
      idle: { type: "gif", source: "idle.gif" },
      thinking: { type: "png-sequence", source: "frames/thinking", pattern: "thinking_*.png" }
    }
  }), "utf8");
}

test("desktop pet catalog binds packs to the role and naturally sorts PNG frames", () => {
  const roleDir = roleFixture();
  writePack(roleDir);

  const catalog = listDesktopPetPacks("YeYu", roleDir);

  assert.equal(catalog.packs.length, 1);
  assert.equal(catalog.packs[0].personaId, "YeYu");
  assert.deepEqual(
    catalog.packs[0].states.thinking.assets.map(asset => asset.split("/").at(-1)),
    ["thinking_2.png", "thinking_10.png"]
  );
  assert.equal(catalog.diagnostics.length, 0);
});

test("desktop pet catalog rejects a manifest owned by another persona", () => {
  const roleDir = roleFixture();
  writePack(roleDir, "OtherRole");

  const catalog = listDesktopPetPacks("YeYu", roleDir);

  assert.equal(catalog.packs.length, 0);
  assert.match(catalog.diagnostics[0].message, /personaId/);
});

test("desktop pet catalog ignores template-only pack skeletons", () => {
  const roleDir = roleFixture();
  const packDir = path.join(roleDir, "desktop-pet", "packs", "draft-pack");
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, "pet-pack.template.json"), "{}", "utf8");

  const catalog = listDesktopPetPacks("YeYu", roleDir);

  assert.deepEqual(catalog.packs, []);
  assert.deepEqual(catalog.diagnostics, []);
});

test("desktop pet API serves role-scoped catalog and image assets", async t => {
  const roleDir = roleFixture();
  writePack(roleDir);
  const settings = new DesktopSettingsStore(path.join(roleDir, "host-settings.json"));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!handleDesktopPetApi(request, requestUrl, response, () => roleDir, settings)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const catalogResponse = await fetch(`${baseUrl}/api/roles/YeYu/desktop-pet/packs`);
  const catalog = await catalogResponse.json() as { data: DesktopPetPackCatalog };
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalog.data.packs[0].personaId, "YeYu");

  const idleUrl = catalog.data.packs[0].states.idle.assets[0];
  const assetResponse = await fetch(`${baseUrl}${idleUrl}`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get("content-type"), "image/gif");
  assert.equal(Buffer.from(await assetResponse.arrayBuffer()).toString("ascii"), "GIF89a");

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(filePath).endsWith("idle.gif")) {
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    }
    return (originalReadFileSync as unknown as (...values: unknown[]) => unknown)(filePath, ...args);
  }) as typeof fs.readFileSync;
  try {
    const exhaustedAssetResponse = await fetch(`${baseUrl}${idleUrl}`);
    assert.equal(exhaustedAssetResponse.status, 503);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  const bindingResponse = await fetch(`${baseUrl}/api/roles/YeYu/desktop-pet`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: "YeYu", enabled: true, packId: "yeyu-library-default", scale: 0.75 })
  });
  assert.equal(bindingResponse.status, 200);
  const bindingPayload = await bindingResponse.json() as { data: { binding: { enabled: boolean; packId: string; scale: number } } };
  assert.equal(bindingPayload.data.binding.enabled, true);
  assert.equal(bindingPayload.data.binding.packId, "yeyu-library-default");
  assert.equal(bindingPayload.data.binding.scale, 0.75);

  const crossPersonaResponse = await fetch(`${baseUrl}/api/roles/YeYu/desktop-pet`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: "OtherRole", enabled: true })
  });
  assert.equal(crossPersonaResponse.status, 400);

  const importResponse = await fetch(
    `${baseUrl}/api/roles/YeYu/desktop-pet/packs/import?fileName=idle.gif&packId=yeyu-second&state=idle&name=${encodeURIComponent("夜雨第二套")}`,
    { method: "POST", headers: { "content-type": "image/gif" }, body: Buffer.from("GIF89a") }
  );
  assert.equal(importResponse.status, 201);
  const refreshedCatalog = await (await fetch(`${baseUrl}/api/roles/YeYu/desktop-pet/packs`)).json() as { data: DesktopPetPackCatalog };
  assert.equal(refreshedCatalog.data.packs.some(pack => pack.id === "yeyu-second"), true);
});

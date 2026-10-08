import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleDesktopPetApi, listDesktopPetPacks } from "./desktopPetRoutes.js";
import { copyDesktopPetPackDirectoryAsync } from "./desktopPetPackImport.js";
import { managerReadWorkerPool } from "./managerReadWorkerPool.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-pet-cache-read-"));
  const role = path.join(root, "role"), cache = path.join(root, "cache");
  fs.mkdirSync(role); fs.mkdirSync(cache);
  return { root, role, cache };
}
function writePack(role: string, id = "selected-pack") {
  const directory = path.join(role, "desktop-pet", "packs", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "idle.gif"), "GIF89a");
  fs.writeFileSync(path.join(directory, "pet-pack.json"), JSON.stringify({
    id, personaId: "YeYu", states: { idle: { type: "gif", source: "idle.gif" } }
  }));
  return directory;
}

test("slow shared pet catalogs leave the Manager health endpoint responsive", async t => {
  const data = fixture(); writePack(data.role);
  let release!: () => void, started!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(managerReadWorkerPool, "queryDesktopPetCatalog", async () => {
    started(); await delayed;
    return listDesktopPetPacks("YeYu", data.role, data.cache);
  });
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.end("ready"); return; }
    handleDesktopPetApi(request, new URL(request.url!, "http://localhost"), response, () => data.role, undefined, data.cache);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { release(); server.close(); fs.rmSync(data.root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const catalog = fetch(`${base}/api/desktop-pet/roles/YeYu/packs`);
  await reading;
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
  assert.equal(await health.text(), "ready");
  release(); assert.equal((await catalog).status, 200);
});

test("selected cached pets stay usable when their shared role root is unavailable", async t => {
  const data = fixture(); writePack(path.join(data.cache, "YeYu"));
  fs.rmSync(data.role, { recursive: true }); fs.writeFileSync(data.role, "unavailable directory");
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const catalog = await managerReadWorkerPool.queryDesktopPetCatalog("YeYu", data.role, data.cache, { packId: "selected-pack" });
  assert.deepEqual(catalog.packs.map(pack => pack.id), ["selected-pack"]);
  assert.deepEqual(catalog.diagnostics, []);
});

test("background pet copies expose their manifest only after every image is complete", async t => {
  const data = fixture(), source = writePack(data.role), destination = path.join(data.cache, "copy");
  let release!: () => void, started!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const copying = new Promise<void>(resolve => { started = resolve; });
  const original = fs.promises.copyFile;
  t.mock.method(fs.promises, "copyFile", async (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith("idle.gif")) { started(); await delayed; }
    return original(...args);
  });
  t.after(() => { release(); fs.rmSync(data.root, { recursive: true, force: true }); });
  const copied = copyDesktopPetPackDirectoryAsync(source, destination);
  await copying;
  assert.equal(fs.existsSync(path.join(destination, "pet-pack.json")), false);
  release(); await copied;
  assert.equal(fs.readFileSync(path.join(destination, "idle.gif"), "utf8"), "GIF89a");
  assert.deepEqual(fs.readFileSync(path.join(destination, "pet-pack.json")), fs.readFileSync(path.join(source, "pet-pack.json")));
  await assert.rejects(copyDesktopPetPackDirectoryAsync(source, destination), /exist/i);
});

test("background pet copies reject linked entries instead of copying outside the pack", async t => {
  const data = fixture(), source = writePack(data.role);
  const outside = path.join(data.root, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.txt"), "sentinel");
  fs.symlinkSync(outside, path.join(source, "linked"), "junction");
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await assert.rejects(copyDesktopPetPackDirectoryAsync(source, path.join(data.cache, "copy")), /Unsupported/);
  assert.equal(fs.readFileSync(path.join(outside, "private.txt"), "utf8"), "sentinel");
  assert.equal(fs.existsSync(path.join(data.cache, "copy", "pet-pack.json")), false);
});

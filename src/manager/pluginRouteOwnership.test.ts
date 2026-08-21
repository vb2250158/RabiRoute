import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("plugin-owned Manager APIs have no legacy central dispatch branches", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  for (const route of [
    "/api/playback/request",
    "/api/fennenote/playback",
    "/api/fennenote/reply",
    "/api/message-processing/board"
  ]) {
    assert.doesNotMatch(
      central,
      new RegExp(`requestUrl\\.pathname\\s*===\\s*[\\\"']${route.replaceAll("/", "\\/")}`),
      `${route} must remain owned by its plugin route module`
    );
  }
  assert.doesNotMatch(central, /function forwardFenneNoteRequest\s*\(/);
  assert.doesNotMatch(central, /function forwardPlaybackRequest\s*\(/);
});

test("plugin route modules retain every migrated compatibility endpoint", () => {
  const fenne = source("src/manager/fenneNoteOutputService.ts");
  for (const route of ["/api/playback/request", "/api/fennenote/playback", "/api/fennenote/reply"]) {
    assert.match(fenne, new RegExp(route.replaceAll("/", "\\/")));
  }

  const messageProcessing = source("src/manager/messageProcessingRoutes.ts");
  for (const route of [
    "/api/message-processing/board",
    "/api/message-processing/requirements"
  ]) {
    assert.match(messageProcessing, new RegExp(route.replaceAll("/", "\\/")));
  }
});

test("Outbox imports the shared FenneNote output implementation", () => {
  const outbox = source("src/outbox.ts");
  assert.match(outbox, /from "\.\/fenneNoteOutput\.js"/);
  assert.doesNotMatch(outbox, /async function postFenneNoteOutput\s*\(/);
});

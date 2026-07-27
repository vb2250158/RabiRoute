import assert from "node:assert/strict";
import test from "node:test";
import { appendWebguiTokenQuery, captureWebguiTokenFromHref } from "../src/webguiAccessToken.js";

test("captures the requested hash-route WebGUI token and removes it from the visible URL", () => {
  const result = captureWebguiTokenFromHref("http://192.168.1.20:8790/#/overview?webgui_token=secret&tab=routes");
  assert.equal(result.token, "secret");
  assert.equal(result.sanitizedHref, "http://192.168.1.20:8790/#/overview?tab=routes");
});

test("also accepts a token before the hash for compatibility", () => {
  const result = captureWebguiTokenFromHref("http://192.168.1.20:8790/?webgui_token=secret#/overview");
  assert.equal(result.token, "secret");
  assert.equal(result.sanitizedHref, "http://192.168.1.20:8790/#/overview");
});

test("adds the session token to EventSource and direct resource URLs", () => {
  assert.equal(
    appendWebguiTokenQuery("/api/events", "secret", "http://192.168.1.20:8790/#/overview"),
    "http://192.168.1.20:8790/api/events?webgui_token=secret"
  );
});

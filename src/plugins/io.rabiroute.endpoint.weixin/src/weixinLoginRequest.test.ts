import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearWeixinLoginRequest,
  hasActiveWeixinLoginRequest,
  requestWeixinLogin
} from "./weixinLoginRequest.js";

test("personal Weixin QR work starts only after a bounded explicit login request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-weixin-login-"));
  try {
    const now = new Date("2026-07-31T00:00:00.000Z");
    assert.equal(hasActiveWeixinLoginRequest(root, now), false);
    requestWeixinLogin(root, now);
    assert.equal(hasActiveWeixinLoginRequest(root, new Date(now.getTime() + 60_000)), true);
    assert.equal(hasActiveWeixinLoginRequest(root, new Date(now.getTime() + 11 * 60_000)), false);
    clearWeixinLoginRequest(root);
    assert.equal(hasActiveWeixinLoginRequest(root, now), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

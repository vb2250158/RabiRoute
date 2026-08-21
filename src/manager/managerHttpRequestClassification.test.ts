import assert from "node:assert/strict";
import test from "node:test";
import { isManagerControlRequestPath } from "./managerHttpRequestClassification.js";

test("Manager control request classification keeps plugin APIs out of the WebGUI fallback", () => {
  for (const pathname of [
    "/api",
    "/api/agent/send",
    "/roles",
    "/roles/Rabi/memory/recent",
    "/meta",
    "/gateways",
    "/gateways/main/restart",
    "/network-options",
    "/reload",
    "/manager-config",
    "/open-config-file",
    "/manager",
    "/manager/start",
    "/manager/desktop-lifecycle",
    "/manager/desktop-lifecycle/start",
    "/manager/shutdown",
    "/manager/shutdow",
    "/manager/unknown"
  ]) {
    assert.equal(isManagerControlRequestPath(pathname), true, pathname);
  }
});

test("WebGUI pages and static assets remain eligible for the UI fallback", () => {
  for (const pathname of ["/", "/settings", "/manager2", "/assets/logo.png", "/docs/getting-started"]) {
    assert.equal(isManagerControlRequestPath(pathname), false, pathname);
  }
});

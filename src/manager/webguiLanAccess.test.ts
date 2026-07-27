import assert from "node:assert/strict";
import test from "node:test";
import type http from "node:http";
import {
  WEBGUI_TOKEN_HEADER,
  generateWebguiAccessToken,
  isLoopbackBindHost,
  isLoopbackRemoteAddress,
  isLocalMachineRemoteAddress,
  isPublicWebguiStaticRequest,
  isWebguiLanRequestAuthorized,
  lanAddressPriority,
  managerListensOnLan,
  normalizeWebguiLanAccessConfig,
  webguiRequestToken,
  webguiTokenMatches
} from "./webguiLanAccess.js";

function request(remoteAddress: string, token = ""): http.IncomingMessage {
  return {
    headers: token ? { [WEBGUI_TOKEN_HEADER]: token } : {},
    socket: { remoteAddress }
  } as unknown as http.IncomingMessage;
}

test("LAN WebGUI access defaults closed and normalizes persisted input", () => {
  assert.deepEqual(normalizeWebguiLanAccessConfig(undefined), { enabled: false, accessToken: "" });
  assert.deepEqual(normalizeWebguiLanAccessConfig({ enabled: true, accessToken: "  secret  " }), {
    enabled: true,
    accessToken: "secret"
  });
});

test("generated WebGUI access tokens are URL-safe and high entropy", () => {
  const first = generateWebguiAccessToken();
  const second = generateWebguiAccessToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test("loopback and LAN hosts are classified separately", () => {
  assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackRemoteAddress("192.168.1.20"), false);
  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
  assert.equal(managerListensOnLan("::"), true);
});

test("management requests recognize the Manager PC's own LAN addresses", () => {
  const localAddresses = ["192.168.0.57", "10.0.0.8"];
  assert.equal(isLocalMachineRemoteAddress("::ffff:192.168.0.57", localAddresses), true);
  assert.equal(isLocalMachineRemoteAddress("127.0.0.1", localAddresses), true);
  assert.equal(isLocalMachineRemoteAddress("192.168.0.88", localAddresses), false);
});

test("copy-link address ordering prefers physical private LANs over virtual adapters", () => {
  assert.ok(lanAddressPriority("Wi-Fi", "192.168.0.57") < lanAddressPriority("Radmin VPN", "26.26.26.1"));
  assert.ok(lanAddressPriority("Ethernet", "10.0.0.8") < lanAddressPriority("vEthernet (WSL)", "172.23.166.58"));
});

test("WebGUI token supports the dedicated header and URL query", () => {
  assert.equal(webguiRequestToken(request("192.168.1.20", "header-token"), new URL("http://pc/meta")), "header-token");
  assert.equal(webguiRequestToken(request("192.168.1.20"), new URL("http://pc/api/events?webgui_token=query-token")), "query-token");
  assert.equal(webguiTokenMatches("same", "same"), true);
  assert.equal(webguiTokenMatches("wrong", "same"), false);
});

test("loopback requests bypass LAN token while remote requests fail closed", () => {
  const config = { enabled: true, accessToken: "expected-token" };
  assert.equal(isWebguiLanRequestAuthorized(request("127.0.0.1"), new URL("http://pc/gateways"), config), true);
  assert.equal(isWebguiLanRequestAuthorized(request("192.168.1.20", "expected-token"), new URL("http://pc/gateways"), config), true);
  assert.equal(isWebguiLanRequestAuthorized(request("192.168.1.20", "wrong"), new URL("http://pc/gateways"), config), false);
  assert.equal(isWebguiLanRequestAuthorized(request("192.168.1.20"), new URL("http://pc/gateways"), { enabled: true, accessToken: "" }), false);
});

test("only the WebGUI shell and public build assets load before authorization", () => {
  assert.equal(isPublicWebguiStaticRequest("GET", "/"), true);
  assert.equal(isPublicWebguiStaticRequest("GET", "/assets/index.js"), true);
  assert.equal(isPublicWebguiStaticRequest("GET", "/reports/benchmark.html"), true);
  assert.equal(isPublicWebguiStaticRequest("GET", "/meta"), false);
  assert.equal(isPublicWebguiStaticRequest("POST", "/"), false);
});

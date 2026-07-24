import assert from "node:assert/strict";
import test from "node:test";
import { hostOwnedSpeechMessageCommand } from "./speechMessageIngress.js";

test("Manager owns speech processing host identity and ignores caller spoofing", () => {
  const command = hostOwnedSpeechMessageCommand({
    gatewayId: "Rabi-main",
    text: "远程音频",
    sourceHostId: "spoofed-host",
    sourceHostName: "Spoofed PC"
  }, {
    rabiGuid: "real-host-guid",
    rabiName: "Studio PC",
    fallbackHostName: "fallback-host"
  });

  assert.equal(command.routeId, "Rabi-main");
  assert.equal(command.sourceHostId, "real-host-guid");
  assert.equal(command.sourceHostName, "Studio PC");
});

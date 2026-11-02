import assert from "node:assert/strict";
import test from "node:test";
import { parseManagedHaEndpoint, parseManagedHaObservation } from "./homeAssistantOs.js";

test("managed endpoint is accepted only as one complete privileged-child receipt", () => {
  const receipt = { address: "192.168.1.21", port: 80, vmId: "00000000-0000-0000-0000-000000000001", legacyBindingVerified: true };
  const line = `RABIROUTE_HA_ENDPOINT:${JSON.stringify(receipt)}`;
  assert.deepEqual(parseManagedHaEndpoint(`diagnostic\n${line}\n`), receipt);
  assert.throws(() => parseManagedHaEndpoint(""), /missing or ambiguous/);
  assert.throws(() => parseManagedHaEndpoint(`${line}\n${line}`), /missing or ambiguous/);
  for (const bad of [{ ...receipt, port: 443 }, { ...receipt, address: "example.com" }, { ...receipt, vmId: "other" }, { ...receipt, legacyBindingVerified: "true" }]) {
    assert.throws(() => parseManagedHaEndpoint(`RABIROUTE_HA_ENDPOINT:${JSON.stringify(bad)}`), /invalid/);
  }
});

test("read-only observation accepts only a complete trusted ready receipt or an explicit unavailable result", () => {
  const endpoint = { address: "192.168.1.21", port: 80, vmId: "00000000-0000-0000-0000-000000000001", legacyBindingVerified: true };
  const ready = `RABIROUTE_HA_OBSERVATION:${JSON.stringify({ ready: true, ...endpoint })}`;
  assert.deepEqual(parseManagedHaObservation(ready), endpoint);
  assert.equal(parseManagedHaObservation('RABIROUTE_HA_OBSERVATION:{"ready":false}'), undefined);
  assert.throws(() => parseManagedHaObservation(`${ready}\n${ready}`), /ambiguous/);
  assert.throws(() => parseManagedHaObservation('RABIROUTE_HA_OBSERVATION:{"ready":false,"address":"127.0.0.1"}'), /invalid/);
  assert.throws(() => parseManagedHaObservation('RABIROUTE_HA_OBSERVATION:{"ready":true,"port":80}'), /invalid/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRabiPcVersion, rabiPcVersionAdvertisement, rabiPcVersionFromCapabilities } from "./rabiPcVersionContract.js";

test("Rabi PC version advertisements round trip through the existing Relay limits", () => {
  for (const version of ["0.3.19", "1.2.3-dev.1", "2.0.0-rc.2"]) {
    const advertisement = rabiPcVersionAdvertisement(version);
    assert.ok(advertisement);
    assert.match(advertisement, /^[a-z][a-z0-9._-]{0,31}$/);
    assert.equal(rabiPcVersionFromCapabilities(["webgui", advertisement]), version);
  }
  for (const version of [undefined, null, "unknown", " 0.3.19", "01.2.3", "1.2.03", "1.2.3-01", "1.2.3-RC.1", "1.2.3+build", "1.2.3-" + "a".repeat(64)]) {
    assert.equal(normalizeRabiPcVersion(version), null);
    assert.equal(rabiPcVersionAdvertisement(version), null);
  }
});

test("missing, invalid and conflicting advertisements remain unknown", () => {
  const current = rabiPcVersionAdvertisement("0.3.19")!;
  const old = rabiPcVersionAdvertisement("0.3.18")!;
  assert.equal(rabiPcVersionFromCapabilities([]), null);
  assert.equal(rabiPcVersionFromCapabilities(["webgui"]), null);
  assert.equal(rabiPcVersionFromCapabilities([current, current]), "0.3.19");
  for (const capabilities of [[current, old], [current, "rabi-pc-version-unknown"], [current.toUpperCase()], ["rabi-pc-version-" + "x".repeat(500)], ["rabi-pc-version-<script>"], ["rabi-pc-version-1.2.3+build"], undefined]) {
    assert.equal(rabiPcVersionFromCapabilities(capabilities), null);
  }
});

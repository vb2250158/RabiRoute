import assert from "node:assert/strict";
import test from "node:test";
import {
  createWearableCompanionRuntimeIdentity,
  resolveWearableCompanionPwshPath
} from "./wearableCompanionRuntimeIdentity.js";

test("wearable companion runtime identity is complete and structured-clone safe", () => {
  const identity = createWearableCompanionRuntimeIdentity({
    hostOwned: true,
    managerBaseUrl: "http://127.0.0.1:54321",
    applicationGenerationId: "generation-one",
    managerInstanceId: "manager-one",
    runtimeRoot: "C:\\RabiRoute",
    explicitPwshPath: "C:\\PowerShell\\pwsh.exe",
    environment: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Android\\platform-tools",
      RABILINK_RELAY_APP_TOKEN: "must-not-cross-plugin-boundary"
    }
  }, {
    isFile: candidate => candidate === "C:\\PowerShell\\pwsh.exe",
    realpath: candidate => candidate
  });

  assert.deepEqual(structuredClone(identity), identity);
  assert.equal(identity.managerBaseUrl, "http://127.0.0.1:54321");
  assert.equal(identity.pwshPath, "C:\\PowerShell\\pwsh.exe");
  assert.equal(identity.stateRoot, "C:\\RabiRoute\\data\\wearable-companion");
  assert.equal(identity.logRoot, "C:\\RabiRoute\\logs\\wearable-companion");
  assert.equal(identity.environment.RABILINK_RELAY_APP_TOKEN, undefined);
});

test("wearable companion runtime identity degrades without PowerShell 7", () => {
  const identity = createWearableCompanionRuntimeIdentity({
    hostOwned: true,
    managerBaseUrl: "http://localhost:61234",
    applicationGenerationId: "generation-two",
    managerInstanceId: "manager-two",
    runtimeRoot: "C:\\RabiRoute",
    environment: {}
  }, { wherePwsh: () => [], isFile: () => false });
  assert.equal(identity.pwshPath, undefined);
  assert.match(identity.unavailableReason ?? "", /PowerShell 7/);
});

test("wearable companion runtime identity degrades on network roots and rejects arbitrary URLs", () => {
  assert.throws(() => createWearableCompanionRuntimeIdentity({
    hostOwned: true,
    managerBaseUrl: "http://192.168.1.20:54321",
    applicationGenerationId: "generation",
    managerInstanceId: "manager",
    runtimeRoot: "C:\\RabiRoute"
  }), /loopback/);
  const network = createWearableCompanionRuntimeIdentity({
    hostOwned: true,
    managerBaseUrl: "http://127.0.0.1:54321",
    applicationGenerationId: "generation",
    managerInstanceId: "manager",
    runtimeRoot: "\\\\server\\RabiRoute"
  });
  assert.equal(network.pwshPath, undefined);
  assert.match(network.unavailableReason ?? "", /local disk/);
});

test("standalone Manager identity degrades before resolving PowerShell", () => {
  let resolvedPowerShell = false;
  const identity = createWearableCompanionRuntimeIdentity({
    hostOwned: false,
    managerBaseUrl: "http://127.0.0.1:54321",
    applicationGenerationId: "standalone-manager-generation",
    managerInstanceId: "standalone-manager",
    runtimeRoot: "C:\\RabiRoute",
    explicitPwshPath: "C:\\PowerShell\\pwsh.exe",
    environment: {}
  }, {
    wherePwsh: () => {
      resolvedPowerShell = true;
      return ["C:\\PowerShell\\pwsh.exe"];
    },
    isFile: () => {
      resolvedPowerShell = true;
      return true;
    }
  });

  assert.equal(identity.hostOwned, false);
  assert.equal(identity.pwshPath, undefined);
  assert.equal(resolvedPowerShell, false);
  assert.match(identity.unavailableReason ?? "", /Host-owned Manager generation/);
});

test("PowerShell resolver never accepts a network or wrong executable", () => {
  assert.equal(resolveWearableCompanionPwshPath("\\\\server\\pwsh.exe", {}, {
    isFile: () => true,
    realpath: candidate => candidate
  }), undefined);
  assert.equal(resolveWearableCompanionPwshPath("C:\\Tools\\powershell.exe", {}, {
    isFile: () => true,
    realpath: candidate => candidate
  }), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceAssistantHostAccess } from "./voiceAssistantHostAccess.js";

test("read-only Host permits existing identity lookup but never dispatch admission", () => {
  let readOnly = true, active = true, identityReads = 0;
  const access = createVoiceAssistantHostAccess({ readOnly: () => readOnly,
    assertActive() { if (!active) throw Error("host retired"); },
    deliveryAuthorityId() { identityReads++; return "existing-local-identity"; }
  });
  assert.equal(access.deliveryAuthorityId(), "existing-local-identity");
  assert.equal(identityReads, 1);
  assert.throws(access.assertSendAllowed, /admission is unavailable/);
  assert.equal(identityReads, 1, "denied send never even requests its source identity");
  readOnly = false; access.assertSendAllowed();
  assert.equal(access.deliveryAuthorityId(), "existing-local-identity");
  active = false;
  assert.throws(access.deliveryAuthorityId, /host retired/);
  assert.throws(access.assertSendAllowed, /host retired/);
  assert.equal(identityReads, 2);
});


test("read-only HTTP policy keeps voice commands and Agent sends blocked", async () => {
  const { managerReadOnlyRequestAllowed } = await import("./managerRuntimeMode.js");
  for (const route of ["/api/voice-assistant/command", "/api/agent/threads", "/api/agent/deliver"])
    assert.equal(managerReadOnlyRequestAllowed("POST", route), false);
  assert.equal(managerReadOnlyRequestAllowed("GET", "/api/voice-assistant/state"), true);
});

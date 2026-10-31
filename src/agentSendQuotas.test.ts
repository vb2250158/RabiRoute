import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fixture = String.raw`
  import assert from "node:assert/strict";
  import { Readable } from "node:stream";
  import { prepareAgentSendRequest } from "./src/agentSend.ts";
  import { agentSendQuotaSettings, AGENT_SEND_REQUEST_CONTRACT } from "./src/agentSendContracts.ts";
  import { markdownImageSettings } from "./src/markdownImage.ts";
  import { agentSendOperationContract } from "./src/manager/agentSendOperations.ts";
  import { compileApiOperation, readApiOperationInput } from "./src/manager/apiOperationContract.ts";
  const operation = compileApiOperation({ contract: agentSendOperationContract, handler: () => ({ status: 200 }) });
  const request = payload => ({ deliveryId: "quota-test", sender: { agentType: "codex", sessionId: "quota-session" }, routeId: "fixture", channel: "napcat", params: { target: "private", userId: "fixture-user" }, payload });
  const schemaRead = async payload => {
    const input = Readable.from([Buffer.from(JSON.stringify(request(payload)))]);
    input.headers = { "content-type": "application/json" };
    return readApiOperationInput(operation, input, new URL("http://localhost/api/agent/send"), {});
  };
  const image = { type: "image", url: "https://example.invalid/image.png" };
  const help = AGENT_SEND_REQUEST_CONTRACT.validators.find(v => v.id === "agent.send.quotas").description;
  for (const [key, value] of Object.entries({ RABIROUTE_AGENT_SEND_MAX_SEGMENTS: agentSendQuotaSettings.segments, RABIROUTE_AGENT_SEND_MAX_IMAGES: agentSendQuotaSettings.images, RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES: markdownImageSettings.sourceBytes })) assert.ok(help.includes(key + "=" + value));
  if (process.env.QUOTA_CASE === "restricted") {
    const cases = [
      [{ type: "markdown", text: "中文" }, "RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES=3"],
      [{ type: "image", segments: [{ type: "markdown", text: "中文" }] }, "RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES=3"],
      [{ type: "image", segments: [image, { type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" }] }, "RABIROUTE_AGENT_SEND_MAX_SEGMENTS=3"],
      [{ type: "image", segments: [image, image] }, "RABIROUTE_AGENT_SEND_MAX_IMAGES=1"]
    ];
    for (const [payload, source] of cases) {
      await schemaRead(payload); // Quotas reach the owner, preserving actionable setting-specific errors.
      assert.throws(() => prepareAgentSendRequest(request(payload)), error => error.message.includes(source) && error.message.includes("set 0"));
    }
    prepareAgentSendRequest(request({ type: "image", segments: [image, { type: "text", text: "ok" }] }));
  } else {
    const large = "中".repeat(12000);
    for (const payload of [
      { type: "markdown", text: large },
      { type: "image", segments: [{ type: "markdown", text: large }] },
      { type: "image", segments: Array.from({ length: 34 }, (_, i) => i % 2 ? image : { type: "text", text: "caption" }) }
    ]) {
      await schemaRead(payload);
      prepareAgentSendRequest(request(payload));
    }
  }
`;

test("send quotas default to unlimited, respect explicit settings, and can be removed on reload", () => {
  const names = ["RABIROUTE_AGENT_SEND_MAX_SEGMENTS", "RABIROUTE_AGENT_SEND_MAX_IMAGES", "RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES"];
  const baseline = { ...process.env };
  for (const name of names) delete baseline[name];
  for (const settings of [
    { QUOTA_CASE: "default" },
    { QUOTA_CASE: "restricted", RABIROUTE_AGENT_SEND_MAX_SEGMENTS: "3", RABIROUTE_AGENT_SEND_MAX_IMAGES: "1", RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES: "3" },
    { QUOTA_CASE: "removed", RABIROUTE_AGENT_SEND_MAX_SEGMENTS: "0", RABIROUTE_AGENT_SEND_MAX_IMAGES: "0", RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES: "0" },
    { QUOTA_CASE: "deleted" }
  ]) {
    const result = spawnSync(process.execPath, ["--import", "./scripts/test-manager-runtime-env.mjs", "--import", "tsx", "--input-type=module", "-e", fixture], {
      cwd: process.cwd(), env: { ...baseline, ...settings }, encoding: "utf8", timeout: 30000, windowsHide: true
    });
    assert.equal(result.status, 0, `${settings.QUOTA_CASE}: ${result.error || result.stderr || result.stdout}`);
  }
});

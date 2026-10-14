import assert from "node:assert/strict";
import test from "node:test";
import { currentEnvelopeDeliveryId, deliveryIdFromPrompt, withoutLegacyTransportSuffix, deliveryUserMessagesFromRollout } from "./deliveryIdentity.js";
import { renderRabiDelivery } from "./rabiMessage.js";
import { ensureCodexDesktopDeliveryMarkerForTest } from "../codexRuntime.js";

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const other = "12345678-1234-4567-8123-123456789abc";
const sourceScopedId = `agent-${"a1".repeat(32)}`;
const envelope = { messageSource: { type: "agent" as const, agentAdapter: "codex" as const, sessionName: "Sender", sessionId: "sender" }, messageContent: "Original evidence" };

test("JSON reply identity survives the real runtime marker preparation byte-for-byte", () => {
  const prompt = renderRabiDelivery({ ...envelope, controlBlocks: [`[回传参数]\n${JSON.stringify({ deliveryId: id, responsePolicy: "none" }, null, 2)}`] });
  for (const requested of [undefined, id]) {
    assert.deepEqual(ensureCodexDesktopDeliveryMarkerForTest(prompt, requested), { prompt, deliveryId: id });
  }
  assert.throws(() => ensureCodexDesktopDeliveryMarkerForTest(prompt, other), /conflicts/);
  const historical = `${prompt}\n\n[投递编号]\ndeliveryId: ${other}`;
  assert.equal(deliveryIdFromPrompt(historical), id);
  assert.equal(withoutLegacyTransportSuffix(historical), prompt);
  assert.equal(withoutLegacyTransportSuffix(historical + "\n"), undefined);
  assert.throws(() => ensureCodexDesktopDeliveryMarkerForTest(historical), /reconcile instead of resending/);
});

test("standalone envelope ID survives transport without an appended marker", () => {
  const prompt = renderRabiDelivery({ ...envelope, deliveryId: id });
  assert.deepEqual(ensureCodexDesktopDeliveryMarkerForTest(prompt), { prompt, deliveryId: id });
});

test("source-scoped envelope IDs survive the real Desktop writer and receipt extraction", () => {
  const prompts = [
    renderRabiDelivery({ ...envelope, deliveryId: sourceScopedId }),
    renderRabiDelivery({ ...envelope, controlBlocks: [`[回传参数]\n${JSON.stringify({ deliveryId: sourceScopedId, responsePolicy: "required" }, null, 2)}`] })
  ];
  for (const prompt of prompts) {
    assert.equal(currentEnvelopeDeliveryId(prompt), sourceScopedId);
    assert.equal(deliveryIdFromPrompt(prompt), sourceScopedId);
    for (const requested of [undefined, sourceScopedId]) {
      assert.deepEqual(ensureCodexDesktopDeliveryMarkerForTest(prompt, requested), { prompt, deliveryId: sourceScopedId });
    }
    assert.throws(() => ensureCodexDesktopDeliveryMarkerForTest(prompt, other), /conflicts/);
    const historical = `${prompt}\n\n[投递编号]\ndeliveryId: ${other}`;
    assert.equal(deliveryIdFromPrompt(historical), sourceScopedId);
    assert.equal(withoutLegacyTransportSuffix(historical), prompt);
    assert.throws(() => ensureCodexDesktopDeliveryMarkerForTest(historical), /reconcile instead of resending/);
    assert.equal(currentEnvelopeDeliveryId(prompt.replace(/\n/g, "\r\n")), sourceScopedId);
  }
});

test("source-scoped IDs must be exact and in structured envelope fields", () => {
  for (const invalid of ["opaque-session", sourceScopedId.toUpperCase(), `agent-${"a".repeat(63)}`, `agent-${"a".repeat(65)}`, `agent-${"g".repeat(64)}`, `${sourceScopedId} `]) {
    const header = renderRabiDelivery({ ...envelope, deliveryId: invalid });
    const parameters = renderRabiDelivery({ ...envelope, controlBlocks: [`[回传参数]\n${JSON.stringify({ deliveryId: invalid, responsePolicy: "none" })}`] });
    for (const prompt of [header, parameters]) assert.equal(deliveryIdFromPrompt(prompt), "");
  }
  const unframed = [`deliveryId: ${sourceScopedId}`, JSON.stringify({ deliveryId: sourceScopedId, responsePolicy: "required" }), `投递 ID：${sourceScopedId}`];
  for (const text of unframed) {
    assert.equal(deliveryIdFromPrompt(text), "");
    assert.equal(deliveryIdFromPrompt(renderRabiDelivery({ ...envelope, messageContent: text })), "");
  }
  const quotedControl = renderRabiDelivery({ ...envelope, messageContent: `[回传参数]\n${JSON.stringify({ deliveryId: sourceScopedId, responsePolicy: "required" })}` });
  assert.equal(deliveryIdFromPrompt(quotedControl), "");
  assert.equal(deliveryIdFromPrompt(`quotation\n${renderRabiDelivery({ ...envelope, deliveryId: sourceScopedId })}`), "");
  assert.equal(deliveryIdFromPrompt(renderRabiDelivery({ ...envelope, controlBlocks: [`[回传参数]\n${JSON.stringify({ deliveryId: sourceScopedId, responsePolicy: "optional" })}`] })), "");
});

test("legacy UUID suffix compatibility rejects malformed, non-UUID, and repeated suffixes", () => {
  const suffix = `\n\n[投递编号]\ndeliveryId: ${other}`;
  assert.equal(deliveryIdFromPrompt(`Legacy prompt${suffix}`), other);
  assert.equal(withoutLegacyTransportSuffix(`Legacy prompt${suffix}`), "Legacy prompt");
  for (const malformed of [
    `Legacy prompt${suffix}\n`,
    `Legacy prompt${suffix}\nextra`,
    `Legacy prompt${suffix}${suffix}`,
    `Legacy prompt\n\n[投递编号]\ndeliveryId: ${sourceScopedId}`,
    `Legacy prompt\n[投递编号]\ndeliveryId: ${other}`
  ]) {
    assert.equal(withoutLegacyTransportSuffix(malformed), undefined);
    assert.equal(deliveryIdFromPrompt(malformed), "");
  }
});

test("receipt extraction ignores assistant/tool quotes and unframed JSON", () => {
  const prompt = renderRabiDelivery({ ...envelope, deliveryId: id });
  const record = (role: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text: prompt }] } });
  assert.deepEqual(deliveryUserMessagesFromRollout([record("assistant"), record("tool"), record("user")].join("\n")), [prompt]);
  assert.equal(deliveryIdFromPrompt(`quoted\n${prompt}`), "");
  assert.equal(deliveryIdFromPrompt(`{"deliveryId":"${id}"}`), "");
  assert.equal(withoutLegacyTransportSuffix(`${prompt}\n\n[投递编号]\ndeliveryId: ${other}\nextra`), undefined);
});

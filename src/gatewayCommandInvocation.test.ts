import assert from "node:assert/strict";
import test from "node:test";
import { resolveGatewayCommandInvocation } from "./gatewayCommandInvocation.js";

test("gateway command invocation recognizes every one-shot entry", () => {
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--wearable-health-alert-stdin"]), "wearable-health-alert-stdin");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--delivery-replay=attempt-one"]), "delivery-replay");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--delivery-replay-message=message-one"]), "delivery-replay");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--manual-trigger=heartbeat"]), "manual-trigger");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--plan-feedback-message=feedback-one"]), "local-agent-message");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--role-panel-message=panel-one"]), "local-agent-message");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--speech-message=speech-one"]), "speech-message");
  assert.equal(resolveGatewayCommandInvocation(["node", "index", "--direct-agent-envelope=%7B%7D"]), "direct-agent-envelope");
});

test("gateway command invocation preserves the existing command precedence", () => {
  assert.equal(resolveGatewayCommandInvocation([
    "--direct-agent-envelope=%7B%7D",
    "--speech-message=speech-one",
    "--manual-trigger=manual-one",
    "--wearable-health-alert-stdin"
  ]), "wearable-health-alert-stdin");
  assert.equal(resolveGatewayCommandInvocation([
    "--role-panel-message=panel-one",
    "--plan-feedback-message=feedback-one"
  ]), "local-agent-message");
});

test("auxiliary arguments alone continue into the resident Gateway", () => {
  assert.equal(resolveGatewayCommandInvocation([
    "node",
    "index",
    "--delivery-replay-mode=merge",
    "--manual-message=hello",
    "--speech-gateway=route-one"
  ]), "gateway-main");
  assert.equal(resolveGatewayCommandInvocation(["node", "index"]), "gateway-main");
});

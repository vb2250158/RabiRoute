import assert from "node:assert/strict";
import test from "node:test";
import { selectAgentThreadRouteId, type AgentThreadRouteCandidate } from "./agentThreadRouteSelection.js";

function candidate(id: string, overrides: Partial<AgentThreadRouteCandidate> = {}): AgentThreadRouteCandidate {
  return {
    id,
    ownedSessionIds: [],
    supportsDsh: true,
    dshWorkspaces: [],
    ...overrides
  };
}

test("target session identity selects its owning Route before workspace fallback", () => {
  const result = selectAgentThreadRouteId({
    targetSessionId: "session-target",
    messageSourceSessionId: "session-source",
    needsDsh: true,
    workspace: "C:/Shared"
  }, [
    candidate("target-route", { ownedSessionIds: ["session-target"], dshWorkspaces: ["C:/Shared"] }),
    candidate("source-route", { ownedSessionIds: ["session-source"], dshWorkspaces: ["C:/Shared"] })
  ]);
  assert.equal(result, "target-route");
});

test("message source or source thread identity can select a Route when the target is unknown", () => {
  const candidates = [
    candidate("route-a", { ownedSessionIds: ["session-source"] }),
    candidate("route-b")
  ];
  assert.equal(selectAgentThreadRouteId({
    targetSessionId: "session-unknown",
    messageSourceSessionId: "session-source",
    needsDsh: true
  }, candidates), "route-a");
  assert.equal(selectAgentThreadRouteId({
    sourceThreadId: "session-source",
    needsDsh: true
  }, candidates), "route-a");
});

test("a unique DSH workspace selects its Route", () => {
  const result = selectAgentThreadRouteId({ needsDsh: true, workspace: "C:/Project/B" }, [
    candidate("route-a", { dshWorkspaces: ["C:/Project/A"] }),
    candidate("route-b", { dshWorkspaces: ["C:/Project/B"] })
  ]);
  assert.equal(result, "route-b");
});

test("multiple DSH Routes remain ambiguous even when they share one endpoint", () => {
  const result = selectAgentThreadRouteId({ needsDsh: true, workspace: "C:/Shared" }, [
    candidate("route-a", { dshWorkspaces: ["C:/Shared"] }),
    candidate("route-b", { dshWorkspaces: ["C:/Shared"] })
  ]);
  assert.equal(result, undefined);
});

test("non-DSH requests do not guess a Route from workspace", () => {
  const result = selectAgentThreadRouteId({ needsDsh: false, workspace: "C:/Project" }, [
    candidate("route-a", { dshWorkspaces: ["C:/Project"] })
  ]);
  assert.equal(result, undefined);
});

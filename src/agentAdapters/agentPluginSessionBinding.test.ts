import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { mergeAgentSessionDescriptors, readAgentSessionBinding } from "./agentPluginSessionBinding.js";
import path from "node:path";
import { canonicalPluginSourceFixture, canonicalPluginSourcesFixture } from "../manager/canonicalPluginSource.fixture.js";

test("a provider reads only its declared task fields", () => {
  const definition = {
    codexThreadId: "original-codex-task", codexThreadName: "Codex", codexCwd: "/codex",
    dshSessionId: "original-dsh-task", dshSessionName: "DSH", dshCwd: "/dsh"
  };
  const descriptor = { type: "dsh", sessionBinding: {
    sessionId: "dshSessionId", sessionName: "dshSessionName", workspace: "dshCwd"
  } };
  assert.deepEqual(readAgentSessionBinding(descriptor, definition), {
    sessionId: "original-dsh-task", sessionName: "DSH", workspace: "/dsh"
  });
  assert.equal(definition.codexThreadId, "original-codex-task");
});

test("providers without a task ID never borrow the Codex task", () => {
  const definition = { codexThreadId: "do-not-retarget", copilotCliCwd: "/copilot", copilotCliThreadName: "Copilot" };
  assert.deepEqual(readAgentSessionBinding({ type: "copilotCli", sessionBinding: {
    workspace: "copilotCliCwd", sessionName: "copilotCliThreadName"
  } }, definition), { workspace: "/copilot", sessionName: "Copilot" });
  assert.deepEqual(readAgentSessionBinding({ type: "marvis", sessionBinding: {} }, definition), {});
  assert.deepEqual(readAgentSessionBinding(undefined, definition), {});
});

test("disabled-package metadata preserves opaque IDs and workspace without normalization", () => {
  const descriptor = { type: "customAgent", sessionBinding: { sessionId: "target", workspace: "cwd" } };
  assert.deepEqual(readAgentSessionBinding(descriptor, { target: "opaque:Original/ID", cwd: "/original cwd" }), {
    sessionId: "opaque:Original/ID", workspace: "/original cwd"
  });
  assert.deepEqual(readAgentSessionBinding(descriptor, { target: null, cwd: 12 }), {});
});

test("all shipped Agent packages preserve their own saved binding fields", async () => {
  const packages = (await canonicalPluginSourcesFixture()).filter(source => source.manifest.id.startsWith("io.rabiroute.agent."));
  assert.equal(packages.length, 9);
  const types = new Set<string>();
  for (const source of packages) {
    const descriptor = JSON.parse(await fs.readFile(path.join(source.directory, "agent-adapter.json"), "utf8"));
    types.add(descriptor.type);
    const definition: Record<string, string> = { codexThreadId: "unrelated-codex-task" };
    const expected: Record<string, string> = {};
    for (const key of ["sessionId", "sessionName", "workspace"]) {
      const field = descriptor.sessionBinding[key];
      if (field) {
        definition[field] = `${descriptor.type}:original:${key}`;
        expected[key] = definition[field]!;
      }
    }
    if (!expected.sessionName && descriptor.sessionBinding.defaultName) expected.sessionName = descriptor.sessionBinding.defaultName;
    assert.deepEqual(readAgentSessionBinding(descriptor, definition), expected, descriptor.type);
  }
  assert.equal(types.size, packages.length);
});

test("primary and secretary workspace checks can keep three distinct provider projects", async () => {
  const definition = {
    codexCwd: "/codex-project", dshCwd: "/dsh-project", antigravityCwd: "/antigravity-project"
  };
  const projects: string[] = [];
  for (const slug of ["codex", "dsh", "antigravity"]) {
    const source = await canonicalPluginSourceFixture(`io.rabiroute.agent.${slug}`);
    const descriptor = JSON.parse(await fs.readFile(
      path.join(source.directory, "agent-adapter.json"), "utf8"));
    projects.push(readAgentSessionBinding(descriptor, definition).workspace!);
  }
  assert.deepEqual(projects, ["/codex-project", "/dsh-project", "/antigravity-project"]);
  assert.equal(readAgentSessionBinding(undefined, definition).workspace, undefined);
});

test("a retained activation keeps its own binding mapping over an installed update", () => {
  const installed = { type: "example", sessionBinding: { sessionId: "newField" } };
  const active = { type: "example", sessionBinding: { sessionId: "originalField" } };
  const definition = { originalField: "original-task", newField: "new-task" };
  assert.deepEqual(readAgentSessionBinding(mergeAgentSessionDescriptors([installed], [active]).get("example"), definition), {
    sessionId: "original-task"
  });
  assert.deepEqual(readAgentSessionBinding(mergeAgentSessionDescriptors([installed], []).get("example"), definition), {
    sessionId: "new-task"
  });
});

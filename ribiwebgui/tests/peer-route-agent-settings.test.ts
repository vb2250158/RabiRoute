import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { postRouteAgentThreadAction } from "../src/routeAgentThreadClient";

const source = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.message-adapter-control/web/components/PeerRouteAgentSettings.vue", import.meta.url), "utf8");
function fixture(responses: Array<Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [], selected: unknown[] = [];
  let unmount = () => {};
  let referenceChanged = (_value: unknown) => {};
  const props = { target: { id: "peer:pc-b:instance-b:codex", provider: "codex", instanceId: "instance-b", agentId: "codex", ownerDeviceId: "pc-b", sessionId: "original" }, connected: true };
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const response = responses.shift(); if (!response) throw new Error("Unexpected request"); return response;
  }) as typeof fetch;
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + "\nreturn { refresh, select, selectedId, sessions, error };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const state = vm.runInNewContext(`(function(){${code}})()`, {
    ref: (value: unknown) => ({ value }), watch: (_: unknown, callback: (value: unknown) => void) => { referenceChanged = callback; callback(props.target); },
    defineProps: () => props, defineEmits: () => (_name: string, value: unknown) => selected.push(value),
    onBeforeUnmount: (callback: () => void) => { unmount = callback; }, managerAccessToken: () => "", userFacingError: String,
    postRouteAgentThreadAction: (payload: Record<string, unknown>, target: Parameters<typeof postRouteAgentThreadAction>[1]) => postRouteAgentThreadAction(payload, target, { fetch: fetcher, accessToken: () => "" })
  });
  return { state, calls, selected, unmount: () => unmount(), replaceReference: (sessionId: string) => {
    props.target.sessionId = sessionId; referenceChanged(props.target);
  } };
}

test("peer settings list and read the original native session without configuring a Route on the target", async () => {
  const f = fixture([Response.json({ threads: [{ id: "full-task", title: "Task", cwd: "/b" }] }), Response.json({ thread: { id: "full-task", title: "Task", cwd: "/b" } })]);
  await f.state.refresh(); f.state.selectedId.value = "full-task"; await f.state.select();
  assert.deepEqual(f.calls.map(call => call.url), ["/api/agent/threads", "/api/agent/threads"]);
  assert.deepEqual(f.calls.map(call => call.body.action), ["list", "read"]);
  assert.equal((f.calls[1].body.instanceBinding as { ownerDeviceId: string }).ownerDeviceId, "pc-b");
  assert.equal(f.calls[1].body.threadId, "full-task");
  assert.equal(JSON.stringify(f.selected), JSON.stringify([{ sessionId: "full-task", sessionName: "Task", workspace: "/b" }]));
});

test("late and failed peer reads preserve the saved reference and emit no target change", async () => {
  let resolve!: (response: Response) => void;
  const held = new Promise<Response>(done => { resolve = done; });
  const f = fixture([held]); f.state.selectedId.value = "next";
  const pending = f.state.select(); f.unmount(); resolve(Response.json({ thread: { id: "next", title: "Late" } })); await pending;
  assert.deepEqual(f.selected, []);
  const failure = fixture([Response.json({ code: -1, message: "offline" }, { status: 503 })]);
  await failure.state.select(); assert.deepEqual(failure.selected, []); assert.match(failure.state.error.value, /offline/);
});

test("same-key draft reload invalidates an older native session read", async () => {
  let resolve!: (response: Response) => void;
  const f = fixture([new Promise<Response>(done => { resolve = done; })]);
  f.state.selectedId.value = "old-selection";
  const pending = f.state.select();
  f.replaceReference("new-reference");
  resolve(Response.json({ thread: { id: "old-selection", title: "Old" } })); await pending;
  assert.deepEqual(f.selected, []); assert.equal(f.state.selectedId.value, "new-reference");
});

test("archived native tasks are not saved as executable Route references", async () => {
  const f = fixture([Response.json({ thread: { id: "original", title: "Archived", archived: true } })]);
  await f.state.select();
  assert.deepEqual(f.selected, []); assert.match(f.state.error.value, /已归档.*原宿主恢复/);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { VideoProjects } from "./projects.mjs";
import { WorkbenchRuns } from "./workbenchRuns.mjs";

// §7.1/§7.2/§9-5: a real run on a throwaway directory, so the log lines, the
// artifact hashes and the run record are produced by the shipping code path
// rather than asserted from a mock.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-log-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  await fs.mkdir(output);
  const binding = { roots: { runtime: root, output, materials: output }, tools: { node: { executable: process.execPath } } };
  const runtime = {
    stateRoot: root,
    workbenchRuntimeRoot: path.join(root, "runtime"),
    machineId: "test-machine",
    generation: "test-generation",
    workbenchBindings: async () => ({ workspaces: { test: binding } }),
    launchWorkbenchProcess(request, sink) {
      const child = spawn(request.executable, request.argv, { cwd: request.cwd, env: request.env, shell: false, windowsHide: true });
      child.stdout.on("data", chunk => sink("stdout", String(chunk)));
      child.stderr.on("data", chunk => sink("stderr", String(chunk)));
      const settled = new Promise(resolve => child.once("close", code => resolve({ exitCode: code, terminated: true })));
      return { id: randomUUID(), settled, cancel: async () => { child.kill(); await settled; } };
    },
  };
  const projects = new VideoProjects(runtime);
  const project = await projects.createProjectV2({ id: randomUUID() });
  const canvas = await projects.readCanvas(project.id, project.defaultCanvasId);
  const owner = new WorkbenchRuns(runtime, projects, { jobs: new Map() }, () => {});
  t.after(() => owner.close());
  const command = (id, text = id) => ({
    id, kind: "command", title: id,
    config: { toolKey: "node", argv: ["-e", `require('fs').writeFileSync(${JSON.stringify(path.join(output, `${id}.txt`))},${JSON.stringify(text)})`] },
    requirements: [{ key: "result", root: "output", path: `${id}.txt`, type: "file", freshness: "produced", required: true }],
  });
  async function run(nodes, edges = [], options = {}) {
    const current = await projects.readCanvas(project.id, canvas.id);
    const saved = await projects.saveCanvas(project.id, canvas.id,
      { ...current, workspaceBindingKey: "test", graph: { nodes, edges, groups: [] } });
    const record = await owner.start(project.id, canvas.id, { id: randomUUID(), revision: saved.revision, ...options });
    await owner.flights.get(record.id);
    return owner.read(record.id);
  }
  return { root, output, owner, project, canvas, run, command };
}

test("a real run writes a scope line, a typed start line and a finish line naming the artifact", async t => {
  const f = await fixture(t);
  const record = await f.run([f.command("prep")]);
  const page = await f.owner.logs(record.id, 0, 100);
  const texts = page.entries.map(row => row.text);
  assert.match(texts[0], /^拓扑序 1 个节点（已禁用跳过 0 个）$/);
  assert.ok(texts.some(text => text === "▶ prep 执行 node -e require('fs')" || text.startsWith("▶ prep 执行 node")), texts.join(" | "));
  assert.ok(texts.includes("✓ prep 生成完成 → prep.txt"), texts.join(" | "));
  assert.equal(page.entries.every(row => typeof row.sequence === "number" && row.sequence > 0), true);
});

test("log rows carry the node id the canvas needs to jump back to the card", async t => {
  const f = await fixture(t);
  const record = await f.run([f.command("prep")]);
  const page = await f.owner.logs(record.id, 0, 100);
  const typed = page.entries.filter(row => row.kind === "start" || row.kind === "finish");
  assert.ok(typed.length >= 2);
  for (const row of typed) assert.equal(row.nodeId, "prep");
});

test("a failed node logs an error line with its reason and keeps the run queryable", async t => {
  const f = await fixture(t);
  const failing = { id: "boom", kind: "command", title: "boom",
    config: { toolKey: "node", argv: ["-e", "process.exit(3)"] }, requirements: [] };
  const record = await f.run([failing]);
  const page = await f.owner.logs(record.id, 0, 100);
  const error = page.entries.find(row => row.kind === "error");
  assert.ok(error, page.entries.map(row => row.text).join(" | "));
  assert.match(error.text, /^✗ boom/);
  assert.equal(error.nodeId, "boom");
});

test("the recorded artifact hash matches the file the run actually produced", async t => {
  // §9-5: this is the check that proves an issue directory can only come from this run.
  const f = await fixture(t);
  const record = await f.run([f.command("prep", "hello-canvas")]);
  const artifacts = Object.values(record.attempts).flatMap(attempt => attempt.artifacts ?? []);
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const { createHash } = await import("node:crypto");
  const actual = createHash("sha256").update(await fs.readFile(path.join(f.output, artifact.path))).digest("hex");
  assert.equal(actual, artifact.sha256);
  assert.equal(artifact.bytes, (await fs.stat(path.join(f.output, artifact.path))).size);
});

test("a disabled node is skipped by the real scheduler and says so in the scope line", async t => {
  const f = await fixture(t);
  const disabled = { ...f.command("off"), enabled: false };
  const record = await f.run([f.command("on"), disabled]);
  const page = await f.owner.logs(record.id, 0, 100);
  assert.match(page.entries[0].text, /已禁用跳过 1 个/);
  assert.equal(record.attempts.off.state, "skipped");
  assert.equal(record.attempts.on.state, "succeeded");
});

test("the run record keeps the frozen graph the log and hashes were produced from", async t => {
  const f = await fixture(t);
  const record = await f.run([f.command("prep")]);
  assert.ok(record.snapshot?.graph?.nodes?.length, "run must freeze the graph");
  assert.equal(record.snapshot.graph.nodes[0].id, "prep");
  const reread = await f.owner.read(record.id);
  assert.deepEqual(reread.snapshot.graph.nodes.map(node => node.id), ["prep"]);
});

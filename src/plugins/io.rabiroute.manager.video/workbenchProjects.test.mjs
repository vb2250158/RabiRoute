import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VideoProjects } from "./projects.mjs";
import { validateCanvas, validateGraph, expandVariables } from "./workbenchGraph.mjs";

async function fixture(t) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new VideoProjects({ stateRoot }), id = randomUUID();
  const project = await store.createProjectV2({ id });
  return { store, id, project, stateRoot };
}
test("separate canvas folders survive reload; CAS is scoped to the edited canvas", async t => {
  const { store, id, project, stateRoot } = await fixture(t);
  const first = await store.readCanvas(id, project.defaultCanvasId), second = await store.createCanvas(id, { id: randomUUID(), name: "第二期" });
  await Promise.all([store.saveCanvas(id, first.id, { ...first, name: "第一期" }), store.saveCanvas(id, second.id, { ...second, name: "第二期修订" })]);
  assert.equal((await store.readProject(id)).revision, 0);
  const attempts = await Promise.allSettled([store.saveCanvas(id, first.id, { ...first, revision: 1, name: "客户端 A" }), store.saveCanvas(id, first.id, { ...first, revision: 1, name: "客户端 B" })]);
  assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1);
  const restored = new VideoProjects({ stateRoot });
  assert.equal((await restored.readCanvas(id, first.id)).revision, 2);
  assert.equal((await restored.readCanvas(id, second.id)).name, "第二期修订");
  assert.ok(await fs.stat(path.join(stateRoot, "projects", id, "canvases", first.id, "materials")));
  await assert.rejects(store.read(id), error => error.status === 426);
  await assert.rejects(store.save(id, { revision: 0, value: null }), error => error.status === 426);
});
test("migration is explicit and lossless with a recoverable original", async t => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-migration-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new VideoProjects({ stateRoot }), id = randomUUID();
  await store.create({ id });
  const value = { version: 1, items: [{ id: "media-1", kind: "video", title: "旧视频", text: "正文", custom: 42 }], active: "media-1", drafts: [["media-1", { prompt: "草稿" }]], positions: { "media-1": { x: 20, y: 30 } }, selected: ["media-1"], audio: [], serviceDeviceId: "peer", extension: { retained: true } };
  await store.save(id, { revision: 0, value });
  const before = await fs.readFile(path.join(store.root, `${id}.json`), "utf8");
  await store.read(id); assert.equal(await fs.readFile(path.join(store.root, `${id}.json`), "utf8"), before);
  await assert.rejects(store.migrateProject(id, { revision: 0 }), error => error.status === 409);
  const project = await store.migrateProject(id, { revision: 1 });
  assert.equal((await store.migrateProject(id, { revision: 1 })).defaultCanvasId, project.defaultCanvasId);
  const canvas = await store.readCanvas(id, project.defaultCanvasId);
  assert.equal(canvas.graph.nodes[0].id, "media-1");
  assert.deepEqual(await store.json(path.join(store.canvasDirectory(id, canvas.id), "materials", "media-editor.json")), value);
  assert.equal(JSON.stringify((await store.json(path.join(store.projectDirectory(id), "migration", "v1-backup.json"))).value), JSON.stringify(value));
  assert.equal((await store.list()).length, 1);
});
test("migration finalization recovers the same canvas after fencing the old writer",async t=>{
  const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),"workbench-finalize-"));t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
  const store=new VideoProjects({stateRoot}),id=randomUUID();await store.create({id});
  const atomic=store.atomic.bind(store);let interrupted=false;
  store.atomic=async(file,value,...args)=>{if(value?.migration?.phase==="committed"&&!interrupted){interrupted=true;throw new Error("commit interrupted");}return atomic(file,value,...args);};
  await assert.rejects(store.migrateProject(id,{revision:0}),/commit interrupted/);
  const prepared=await store.readProject(id,undefined,true);assert.equal(prepared.migration.phase,"prepared");
  await assert.rejects(store.readProject(id),error=>error.status===409);
  assert.equal((await store.list())[0].migrationPending,true);
  const fence=await store.json(path.join(store.legacyRoot,`${id}.json`));assert.equal(fence.revision,null);
  const oldOnly=new VideoProjects({stateRoot,workbenchProjectsRoot:path.join(stateRoot,"other-projects")});
  await assert.rejects(oldOnly.read(id),error=>error.status===409);
  await assert.rejects(oldOnly.save(id,{revision:0,value:null}),error=>error.status===409);
  const committed=await store.migrateProject(id,{revision:0});assert.equal(committed.migration.phase,"committed");
  assert.equal(committed.defaultCanvasId,prepared.defaultCanvasId);assert.equal((await store.readProject(id)).id,id);
});
test("folder copies include materials, remap internal references, and retry without another copy", async t => {
  const { store, id, project } = await fixture(t), canvas = await store.readCanvas(id, project.defaultCanvasId);
  canvas.graph = { nodes: [{ id: "a", kind: "command", config: {} }, { id: "b", kind: "human", config: {}, inputs: [{ producerNodeId: "a", artifactKey: "result" }] }], edges: [{ id: "e", from: "a", to: "b", fromPort: "control", toPort: "control", condition: "success" }], groups: [{ id: "g", nodeIds: ["a", "b"] }] };
  await store.saveCanvas(id, canvas.id, canvas);
  await fs.writeFile(path.join(store.canvasDirectory(id, canvas.id), "materials", "brief.txt"), "任务书");
  const body = { id: randomUUID(), sourceCanvasId: canvas.id, requestId: randomUUID() };
  const copied = await store.copyCanvas(id, body);
  assert.equal((await store.copyCanvas(id, body)).id, copied.id);
  assert.notEqual(copied.graph.nodes[0].id, "a");
  assert.equal(copied.graph.edges[0].from, copied.graph.nodes[0].id);
  assert.equal(copied.graph.nodes[1].inputs[0].producerNodeId, copied.graph.nodes[0].id);
  assert.equal(await fs.readFile(path.join(store.canvasDirectory(id, copied.id), "materials", "brief.txt"), "utf8"), "任务书");
  await assert.rejects(store.copyCanvas(id, { id: randomUUID(), folderName: "../escape", requestId: randomUUID() }));
});
test("paged index handles 5000 canvases without reading graph bodies", async t => {
  const { store, id, project, stateRoot } = await fixture(t), index = path.join(store.projectDirectory(id), ".canvas-index");
  for (let start = 0; start < 5000; start += 100) await Promise.all(Array.from({ length: 100 }, (_, offset) => {
    const row = { id: randomUUID(), name: `期次 ${start + offset}`, revision: 0, nodeCount: 10, updatedAt: "2026-11-17" };
    return fs.writeFile(path.join(index, `${row.id}.json`), JSON.stringify(row));
  }));
  const originalJson = store.json.bind(store);
  store.json = (file, ...args) => { assert.ok(!file.endsWith("canvas.json")); return originalJson(file, ...args); };
  let cursor, count = 0; const seen = new Set();
  do { const page = await store.listCanvases(id, { limit: 100, cursor }); for (const row of page.canvases) { assert.ok(!seen.has(row.id)); seen.add(row.id); count++; } cursor = page.nextCursor; } while (cursor);
  assert.equal(count, 5001);
  const filtered = await store.listCanvases(id, { search: "期次 1234" }); assert.equal(filtered.canvases.length, 1);
  assert.equal((await store.readProject(id)).defaultCanvasId, project.defaultCanvasId);
  const restarted = new VideoProjects({ stateRoot });
  const readJson = restarted.json.bind(restarted);
  restarted.json = (file, ...args) => {
    assert.notEqual(path.dirname(file), index, "an indexed project should not reopen its summary files on restart");
    return readJson(file, ...args);
  };
  const first = await restarted.listCanvases(id, { limit: 50 });
  assert.equal(first.canvases.length, 50);
  assert.equal(first.canvases[0].id, project.defaultCanvasId);
  const source = await restarted.readCanvas(id, project.defaultCanvasId);
  await restarted.saveCanvas(id, source.id, { ...source, name: "刚保存" });
  assert.equal((await restarted.listCanvases(id, { limit: 1 })).canvases[0].name, "刚保存");
  await assert.rejects(restarted.listCanvases(id, { limit: 50, cursor: first.nextCursor }), error => error.status === 409);
});

test("a remotely saved canvas advances a local index through the shared change history", async t => {
  const { store, id, project, stateRoot } = await fixture(t);
  const peer = new VideoProjects({ stateRoot: path.join(stateRoot, "peer"), workbenchProjectsRoot: store.root });
  await peer.listCanvases(id);
  const canvas = await store.readCanvas(id, project.defaultCanvasId);
  await store.saveCanvas(id, canvas.id, { ...canvas, name: "来自另一台电脑" });
  const readJson = peer.json.bind(peer);
  peer.json = (file, ...args) => {
    assert.notEqual(path.dirname(file), store.summaryDirectory(id));
    return readJson(file, ...args);
  };
  assert.equal((await peer.listCanvases(id)).canvases[0].name, "来自另一台电脑");
});

test("committed canvas remains visible when the derived summary write fails", async t => {
  const { store, id, project, stateRoot } = await fixture(t);
  const canvas = await store.readCanvas(id, project.defaultCanvasId);
  const indexEntry = store.indexEntry.bind(store);
  store.indexEntry = async () => { throw new Error("simulated summary I/O error"); };
  const saved = await store.saveCanvas(id, canvas.id, { ...canvas, name: "已保存" });
  assert.equal(saved.revision, 1);
  const restarted = new VideoProjects({ stateRoot });
  assert.equal((await restarted.readCanvas(id, canvas.id)).name, "已保存");
  assert.equal((await restarted.listCanvases(id)).canvases[0].name, "已保存");
  assert.equal((await restarted.readCanvasSummary(id, canvas.id)).revision, 1);
  store.indexEntry = indexEntry;
  await store.saveCanvas(id, canvas.id, { ...saved, name: "已同步" });
  assert.equal((await restarted.listCanvases(id)).canvases[0].name, "已同步");
  assert.deepEqual(await fs.readdir(store.pendingSummaryDirectory(id)), []);
});

test("revision thumbnail serves only card geometry without loading the canvas body", async t => {
  const { store, id, project } = await fixture(t);
  const canvas = await store.readCanvas(id, project.defaultCanvasId);
  canvas.graph.nodes = [{ id: "one", kind: "command", title: "标题不能出现在预览响应", config: {}, layout: { x: 90, y: 150, width: 420, height: 140 } }];
  const saved = await store.saveCanvas(id, canvas.id, canvas);
  store.readCanvas = () => assert.fail("previews should not load the canvas body for a persisted thumbnail");
  const preview = await store.readCanvasThumbnail(id, canvas.id, String(saved.revision));
  assert.deepEqual(preview.thumbnail.nodes, [{ id: "one", x: 90, y: 150, width: 420, height: 140, enabled: true }]);
  assert.equal(Object.hasOwn(preview, "graph"), false);
});
test("graph owner rejects cycles, unsupported ports, missing references and invalid variable values", async t => {
  const { store, id, project } = await fixture(t), canvas = await store.readCanvas(id, project.defaultCanvasId), definition = store.definition;
  const nodes = ["a", "b"].map(id => ({ id, kind: "command", config: {} }));
  const edge = { id: "e", from: "a", to: "b", fromPort: "control", toPort: "control", condition: "success" };
  assert.deepEqual(validateGraph({ nodes, edges: [edge], groups: [] }, definition).order, ["a", "b"]);
  assert.throws(() => validateGraph({ nodes, edges: [edge, { ...edge, id: "f", from: "b", to: "a" }], groups: [] }, definition), /循环/);
  assert.throws(() => validateGraph({ nodes, edges: [{ ...edge, toPort: "missing" }], groups: [] }, definition), /端口/);
  assert.throws(() => validateCanvas({ ...canvas, variables: [{ name: "date", type: "date", value: "2026-02-30" }] }, definition));
  assert.throws(() => expandVariables({ argv: ["${missing}"] }, []), /未知变量/);
});
test("interrupted migration resumes the prepared canvas identity and blocks old clients only after commit",async t=>{
  const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),"workbench-interrupt-"));t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
  const store=new VideoProjects({stateRoot}),id=randomUUID();await store.create({id});
  const publish=store.publishProjectDirectory.bind(store);store.publishProjectDirectory=async()=>{throw new Error("simulated interruption");};
  await assert.rejects(store.migrateProject(id,{revision:0}),/interruption/);assert.equal((await store.read(id)).revision,0);
  const receipt=await store.json(path.join(store.root,".pending",id,"migration","receipt.json"));store.publishProjectDirectory=publish;
  const project=await store.migrateProject(id,{revision:0});assert.equal(project.defaultCanvasId,receipt.canvasId);
  await assert.rejects(store.read(id),error=>error.status===426);
});
test("pasted junctions cannot redirect staged writes or read a foreign record",async t=>{
  const {store,id,project,stateRoot}=await fixture(t),outside=path.join(stateRoot,"outside");await fs.mkdir(outside);
  const pending=path.join(store.projectDirectory(id),".pending");await fs.symlink(outside,pending,"junction");
  await assert.rejects(store.createCanvas(id,{id:randomUUID()}),error=>error.status===403);assert.deepEqual(await fs.readdir(outside),[]);
  const canvas=await store.readCanvas(id,project.defaultCanvasId),directory=store.canvasDirectory(id,canvas.id),foreign=path.join(outside,"canvas");
  await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,"canvas.json"),JSON.stringify(canvas));await fs.rename(directory,`${directory}-saved`);await fs.symlink(foreign,directory,"junction");
  await assert.rejects(store.readCanvas(id,canvas.id),error=>error.status===403);
});

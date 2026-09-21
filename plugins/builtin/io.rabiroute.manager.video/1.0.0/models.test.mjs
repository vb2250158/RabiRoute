import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { VideoModels, downloadFile, safeTarget } from "./models.mjs";

async function fixture(t, dependencies = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-init-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(32); bytes.writeBigUInt64LE(8n); bytes[8] = 123;
  const model = { id: "first", directory: "video/test", files: { diffusion: "base.safetensors", lora: "fast.safetensors", audioVae: "audio.safetensors" }, expectedBytes: { diffusion: 32, lora: 32, audioVae: 32 }, sha256: {}, workflows: { standard: { label: "标准", lora: false }, fast: { label: "快速", lora: true } } };
  const runtime = { stateRoot: root, defaultModelRoot: path.join(root, "models"), alive: () => false, installed: async () => true, validateModelRoot: value => value };
  const models = new VideoModels(runtime, { models: [model, { ...model, id: "second" }] }, () => {}, { availableSpace: async () => 1000, ...dependencies });
  await models.initialize();
  await models.configure({ modelRoot: path.join(root, "main"), layout: "categorized", expectedRevision: 0 });
  const write = async (folder, name) => { const file = path.join(models.modelRoot(model), folder, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  return { models, write, bytes };
}

test("categorized root deduplicates shared weights and permits an installed silent workflow", async t => {
  const { models, write } = await fixture(t);
  await write("diffusion_models", "base.safetensors");
  await models.assertStartable();
  const plan = await models.downloadPlan();
  assert.equal(plan.files.length, 3);
  assert.equal(plan.downloadBytes, 64);
  assert.equal(plan.additionalBytes, 64);
  assert.equal(plan.availableBytes, 1000);
  assert.equal(plan.canDownload, true);
  assert.equal(models.runtimeRoots().length, 1);
  assert.match(plan.files[0].relative, /video[\\/]test/);
  const snapshot = await models.snapshot();
  assert.equal(snapshot.models[0].installed, false);
  assert.deepEqual(snapshot.models[0].workflows[1].missingFiles, ["fast.safetensors"]);
});

test("missing dependencies, insufficient space and stale preview fail explicitly", async t => {
  const { models } = await fixture(t, { availableSpace: async () => 20 });
  await assert.rejects(models.assertStartable(), /base.safetensors/);
  const plan = await models.downloadPlan();
  assert.equal(plan.canDownload, false);
  assert.match(plan.errors.join(), /空间不足/);
  await assert.rejects(models.initializeModels({ expectedRevision: 1 }), /空间不足/);
  await assert.rejects(models.initializeModels({ expectedRevision: 0 }), /目录已改变/);
  assert.equal(models.flight, null);
});

test("bulk initialization skips installed files, downloads shared files once and retains precise failures", async t => {
  let downloads = 0;
  const { models, write, bytes } = await fixture(t, { downloadFile: async (_url, target, _size, _hash, _signal, progress) => {
    downloads++; await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); progress(bytes.length);
  } });
  await write("diffusion_models", "base.safetensors");
  await models.initializeModels({ expectedRevision: 1 });
  await assert.rejects(models.initializeModels({ expectedRevision: 1 }), /等待安装/);
  await models.flight;
  assert.equal(downloads, 2);
  assert.equal(models.job.state, "completed");
  assert.equal(models.job.bytes, 64);
  assert.equal((await models.downloadPlan()).downloadBytes, 0);
  const target = path.join(models.runtimeRoots()[0], "loras", "fast.safetensors");
  await fs.writeFile(target, "invalid");
  const plan = await models.downloadPlan();
  assert.match(plan.errors.join(), /fast.safetensors/);
  await assert.rejects(models.initializeModels({ expectedRevision: 1 }), /不能覆盖/);
});

test("model settings persist without installing; stale writes and running service are rejected", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-model-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let running = false, installs = 0;
  const runtime = { stateRoot: root, defaultModelRoot: path.join(root, "models"), alive: () => running, installed: async () => false, validateModelRoot: value => value, install: async () => { installs++; }, stopInstaller: async () => {} };
  const models = new VideoModels(runtime, { models: [] }, () => {});
  await models.initialize(); assert.equal(installs, 0);
  assert.equal((await models.snapshot()).runtimeInstalled, false);
  await models.configure({ modelRoot: path.join(root, "chosen"), expectedRevision: 0 });
  await assert.rejects(models.configure({ modelRoot: null, expectedRevision: 0 }), /刷新/);
  const restored = new VideoModels(runtime, { models: [] }, () => {});
  await restored.initialize(); assert.equal(restored.root(), path.join(root, "chosen"));
  running = true; await assert.rejects(restored.configure({ modelRoot: null, expectedRevision: 1 }), /停止/);
  running = false; models.installRuntime(); await models.flight; assert.equal(installs, 1);
  await models.close(); assert.throws(() => models.installRuntime(), /停止/);
});

test("download verifies hash and length, never overwrites an existing model, rejects redirected hosts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-download-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test model bytes"), hash = createHash("sha256").update(bytes).digest("hex");
  const target = path.join(root, "model.safetensors"), signal = new AbortController().signal;
  const source = "https://huggingface.co/test/model";
  const fetcher = async () => new Response(bytes);
  await downloadFile(source, target, bytes.length, hash, signal, () => {}, fetcher);
  assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(downloadFile(source, target, bytes.length, hash, signal, () => {}, fetcher), /EEXIST/);
  const bad = path.join(root, "bad.safetensors");
  await assert.rejects(downloadFile(source, bad, bytes.length, "0".repeat(64), signal, () => {}, fetcher), /SHA-256/);
  await assert.rejects(fs.access(bad));
  await assert.rejects(downloadFile(source, bad, bytes.length, hash, signal, () => {}, async () => new Response(null, { status: 302, headers: { location: "https://example.com/model" } })), /不受信任/);
  await assert.rejects(safeTarget(root, "../escape"), /路径/);
});

test("model target refuses a junction beneath the selected directory", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-junction-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "real"));
  await fs.symlink(path.join(root, "real"), path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(safeTarget(root, "link/model"), /联接/);
});

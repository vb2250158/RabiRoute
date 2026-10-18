import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scripts = ["extract-mgq-dialogue-candidates.mjs", "extract-rgss-dialogue-events.mjs"];

function run(script, args) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    encoding: "utf8", timeout: 10000, windowsHide: true
  });
}

test("extractors require explicit paths without accessing machine defaults", () => {
  for (const script of scripts) {
    const result = run(script, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test("translation candidates and Marshal parse errors are written offline", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-dialogue-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const translation = path.join(directory, "translation.json");
  await fs.writeFile(translation, JSON.stringify({ "【アリス】": "【爱丽丝】", "hello": "你好" }));
  const candidates = path.join(directory, "candidates");
  const first = run(scripts[0], [translation, candidates]);
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(await fs.readFile(path.join(candidates, "summary.json"), "utf8"));
  assert.equal(summary.totalEntries, 2);
  assert.equal(summary.counts.aliceSpeakerLabels, 1);
  const windows = JSON.parse((await fs.readFile(path.join(candidates, "alice-dialogue-windows.jsonl"), "utf8")).trim());
  assert.equal(windows.lines[0].zh, "你好");
  const data = path.join(directory, "Data");
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, "Empty.rvdata2"), Buffer.from([4, 8, 91, 0]));
  await fs.writeFile(path.join(data, "Invalid.rvdata2"), Buffer.from([0, 0]));
  const events = path.join(directory, "events");
  const second = run(scripts[1], [data, translation, events]);
  assert.equal(second.status, 0, second.stderr);
  const errors = (await fs.readFile(path.join(events, "parse-errors.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /not Ruby Marshal 4.8/);
  assert.equal(await fs.readFile(path.join(events, "speaker-attributed-dialogue.jsonl"), "utf8"), "");
});

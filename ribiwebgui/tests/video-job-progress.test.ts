import test from "node:test";
import assert from "node:assert/strict";
import { videoProgressPresentation } from "../src/pages/videoJobProgress.ts";
const createdAt = "2026-01-01T00:00:00Z";
const now = Date.parse("2026-01-01T00:02:05Z");
test("progress is explicitly per stage and elapsed generation time excludes queue time", () => {
  const job = { status: "running", createdAt, startedAt: "2026-01-01T00:01:00Z", progressStage: "采样", progressValue: 8, progressMax: 20, progressUnit: "步" };
  assert.deepEqual(videoProgressPresentation(job, now), { label: "采样", percent: 40, count: "8/20 步", elapsed: "已用 1分05秒" });
  assert.equal(videoProgressPresentation({ ...job, progressValue: 0 }, now).percent, 0);
  assert.equal(videoProgressPresentation({ ...job, progressStage: "解码画面", progressValue: null, progressMax: null }, now).percent, null);
});
test("legacy or invalid progress never invents a whole-job percentage", () => {
  assert.equal(videoProgressPresentation({ status: "running", createdAt }, now).percent, null);
  assert.equal(videoProgressPresentation({ status: "running", createdAt, progressStage: "采样", progressValue: NaN, progressMax: 20 }, now).percent, null);
  assert.deepEqual(videoProgressPresentation({ status: "queued", createdAt }, now), { label: "等待前面的任务完成", percent: null, count: "", elapsed: "提交后 2分05秒" });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSpeechIngressSeparationAcceptance } from "./speechIngressSeparation.js";

test("isolated speech ingress acceptance separates PC and mobile persona contexts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-acceptance-test-"));
  const outputPath = path.join(root, "report.json");
  const result = await runSpeechIngressSeparationAcceptance({
    entryPath: path.resolve("src", "index.ts"),
    entryArgsPrefix: ["--import", "tsx"],
    outputPath,
    timeoutMs: 20_000
  }, {
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.acceptancePassed, true);
  assert.deepEqual(result.report.endpoints, ["rabilink", "speech"]);
  assert.deepEqual(result.report.counts, {
    hostRecords: 2,
    pcVoiceHistory: 1,
    mobileVoiceHistory: 1,
    pcConversation: 1,
    mobileConversation: 1
  });
  const evidence = fs.readFileSync(outputPath, "utf8");
  assert.equal(evidence.includes("AcceptancePcPersona"), false);
  assert.equal(evidence.includes("acceptance-stable-device"), false);
  assert.equal(evidence.includes("acceptance-transient-stream"), false);
  assert.equal(evidence.includes("Host Guess"), false);
});

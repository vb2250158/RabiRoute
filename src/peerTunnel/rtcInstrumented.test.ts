import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
// The build compiler is a JavaScript-only tool and has no declaration file.
// @ts-expect-error No TypeScript declarations for the build tool.
import { compileAutomaticCode } from "../../scripts/lib/automatic-code-compiler.mjs";

test("instrumented RTC observes open timeout during slow signaling and joins producer", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rtc-automatic-regression-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const source = fs.readFileSync(new URL("./rtc.ts", import.meta.url), "utf8");
  let javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  javascript = javascript
    .replace("../shared/timeoutSettings.js", "./timeout.mjs")
    .replace('"werift"', '"./rtc-fake.mjs"')
    .replace("./channel.js", "./channel-fake.mjs");
  const runtimeUrl = new URL("../plugin-kernel/automaticCodeRuntime.ts", import.meta.url).href;
  const compiled = compileAutomaticCode(javascript, "peerTunnel/rtc.js", runtimeUrl);
  assert.ok(compiled?.definition?.implementations["TunnelRtc.connect"]);
  fs.writeFileSync(path.join(directory, "rtc.mjs"), compiled.output);
  fs.writeFileSync(path.join(directory, "timeout.mjs"), "export const getTimeoutMs = () => 40;");
  fs.writeFileSync(path.join(directory, "channel-fake.mjs"), "export const rtcChannel = () => ({});");
  fs.writeFileSync(path.join(directory, "rtc-fake.mjs"), `
    const event = () => ({ subscribe: () => ({ unSubscribe() {} }) });
    export class RTCPeerConnection {
      connectionStateChange = event();
      localDescription = { sdp: "v=0\\r\\nm=application 1\\r\\n" };
      createDataChannel() {
        return { label: "rabi.tunnel.v1", ordered: true, readyState: "connecting", stateChange: event() };
      }
      async createOffer() { return {}; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      async close() {}
    }
  `);
  fs.writeFileSync(path.join(directory, "run.mjs"), `
    import { TunnelRtc } from "./rtc.mjs";
    const rtc = new TunnelRtc([]);
    const start = Date.now();
    let producerFinished = false;
    const slowOffer = () => new Promise(resolve => setTimeout(() => {
      producerFinished = true;
      resolve({ sdp: "v=0\\r\\nm=application 1\\r\\n" });
    }, 250));
    try {
      await rtc.connect(slowOffer, new AbortController().signal);
      throw new Error("unexpected success");
    } catch (error) {
      if (error.message !== "Tunnel channel open timed out.") throw error;
    }
    await rtc.stop();
    if (!producerFinished || Date.now() - start < 200) throw new Error("producer not joined");
    console.log("timeout observed; producer joined");
  `);
  const child = spawnSync(process.execPath, [
    "--unhandled-rejections=strict", "--import", "tsx", path.join(directory, "run.mjs")
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /timeout observed; producer joined/);
});

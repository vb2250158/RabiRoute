import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { markdownImageHtml, markdownImageInternals, renderMarkdownToPng } from "./markdownImage.js";

type Command = { id: number; method: string };

class FakeCdpSocket extends EventEmitter {
  readyState = 0;
  commands: Command[] = [];
  onNavigate: (command: Command) => void = () => {};
  closeCalls = 0;

  open() { this.readyState = 1; this.emit("open"); }
  reply(command: Command, result: Record<string, unknown> = {}) {
    this.emit("message", JSON.stringify({ id: command.id, result }));
  }
  send(raw: string) {
    const command = JSON.parse(raw) as Command;
    this.commands.push(command);
    queueMicrotask(() => {
      if (command.method === "Page.navigate") this.onNavigate(command);
      else this.reply(command);
    });
  }
  close() { this.closeCalls++; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}

const flushCdp = () => new Promise<void>(resolve => setImmediate(resolve));

function trackTimers(t: TestContext) {
  const active = new Set<ReturnType<typeof setTimeout>>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    const timer = originalSet(() => { active.delete(timer); callback(); }, delay);
    active.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout>) => {
    active.delete(timer);
    originalClear(timer);
  });
  t.after(() => { for (const timer of active) originalClear(timer); });
  return active;
}

function captureFake(socket: FakeCdpSocket, timeoutMs = 1000) {
  return markdownImageInternals.captureHtmlOnSocket(socket as unknown as WebSocket, "<p>test</p>", timeoutMs);
}

test("fake CDP navigate rejection cancels the pre-registered load timer", async t => {
  const timers = trackTimers(t);
  const socket = new FakeCdpSocket();
  socket.onNavigate = command => socket.emit("message", JSON.stringify({ id: command.id, error: { message: "navigation denied" } }));
  const failed = assert.rejects(captureFake(socket), /navigation denied/);
  socket.open();
  await failed;
  assert.equal(timers.size, 0, "navigation failure must not leave a load-event timer");
  await flushCdp();
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.closeCalls, 1);
});

for (const event of ["close", "error"] as const) {
  for (const phase of ["connecting", "navigating"] as const) {
    test(`fake CDP ${event} while ${phase} ends every wait immediately`, async t => {
      const timers = trackTimers(t);
      const socket = new FakeCdpSocket();
      const failed = assert.rejects(captureFake(socket), event === "close" ? /connection closed/ : /transport failed/);
      if (phase === "navigating") {
        socket.open();
        await flushCdp();
        assert.equal(socket.commands.at(-1)?.method, "Page.navigate");
        assert.equal(timers.size, 2);
      }
      if (event === "close") socket.close();
      else socket.emit("error", new Error("transport failed"));
      await failed;
      assert.equal(timers.size, 0);
      assert.equal(socket.listenerCount("message"), 0);
      assert.equal(socket.listenerCount("open"), 0);
      assert.equal(socket.listenerCount("error"), 0);
      assert.equal(socket.listenerCount("close"), 0);
    });
  }
}

for (const mode of ["no-navigation-reply", "no-load-event", "no-navigation-reply-after-load", "no-open"] as const) {
  test(`fake CDP timeout cleans timers: ${mode}`, async t => {
    const timers = trackTimers(t);
    const socket = new FakeCdpSocket();
    socket.onNavigate = command => {
      if (mode === "no-load-event") socket.reply(command);
      if (mode === "no-navigation-reply-after-load") socket.emit("message", JSON.stringify({ method: "Page.loadEventFired" }));
    };
    const failed = assert.rejects(captureFake(socket, 25), /timed out/);
    if (mode !== "no-open") socket.open();
    await failed;
    assert.equal(timers.size, 0);
    assert.equal(socket.listenerCount("message"), 0);
    assert.equal(socket.listenerCount("open"), 0);
    assert.equal(socket.closeCalls, 1);
    // Let Node report any unobserved rejection from the second, concurrently pending wait.
    await flushCdp();
  });
}

test("Markdown image HTML keeps raw markup and remote images inert", () => {
  const html = markdownImageHtml("# 标题\n\n<script>alert(1)</script>\n\n![secret](https://example.invalid/a.png)\n\n[link](javascript:alert(1))");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("图片：secret"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("href=\"javascript:"));
  assert.ok(html.includes("default-src 'none'"));
});

test("real browser renders Chinese Markdown, a table, and code to PNG", async (t) => {
  let png: Buffer;
  try {
    png = await renderMarkdownToPng("# 构建结果\n\n**通过**：多张图片已按顺序发送。\n\n| 项目 | 状态 |\n| --- | --- |\n| 群聊 | 已完成 |\n\n```ts\nconst count = 2;\n```");
  } catch (error) {
    if (/requires an installed Chromium, Chrome, or Edge browser/.test(String(error))) {
      t.skip("No Chromium-family browser is installed for the image render smoke test.");
      return;
    }
    throw error;
  }
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1000);
  assert.ok(png.readUInt32BE(20) > 200);
  assert.ok(png.length > 10_000);
});

test("empty or oversized Markdown fails before launching a browser", async () => {
  await assert.rejects(renderMarkdownToPng("  "), /must contain text/);
  await assert.rejects(renderMarkdownToPng("中".repeat(12_000)), /at most 32768 UTF-8 bytes/);
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const inkPackageArg = process.argv.indexOf("--ink-package");
const inkPackage = inkPackageArg >= 0 ? process.argv[inkPackageArg + 1] : "@yodaos-pkg/ink";
if (!inkPackage) throw new Error("--ink-package requires a package name.");
const modeArg = process.argv.indexOf("--mode");
const resizeMode = modeArg >= 0 ? process.argv[modeArg + 1] : "transcription";
if (!['transcription', 'configuration'].includes(resizeMode)) throw new Error("--mode must be transcription or configuration.");
const inkRoot = path.join(projectRoot, "node_modules", ...inkPackage.split("/"));
const inkVersion = JSON.parse(fs.readFileSync(path.join(inkRoot, "package.json"), "utf8")).version;
const stagingRoot = path.join(os.tmpdir(), `rabilink-aiui-interactive-resize-${process.pid}-${Date.now()}`);
const runtimeLabel = inkPackage === "@yodaos-pkg/ink" ? "stable" : inkPackage.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
const reportLabel = `${runtimeLabel}-${resizeMode}`;
const reportPath = path.join(projectRoot, "dist", `ink-interactive-resize-${reportLabel}.json`);
const screenshotPath = path.join(projectRoot, "dist", `ink-interactive-resize-${reportLabel}.png`);

function collectBundleFiles(root, relative = "") {
  const files = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) Object.assign(files, collectBundleFiles(root, nextRelative));
    else if (entry.isFile()) files[nextRelative.replaceAll("\\", "/")] = fs.readFileSync(path.join(root, nextRelative)).toString("base64");
  }
  return files;
}

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function harnessHtml(encoded, mode) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#111}canvas{display:block}</style></head>
<body><div id="cardHost"><canvas id="ink" width="448" height="150"></canvas></div><div id="modalHost"></div><script type="module">
import { configNavigatorHost, createInkView } from "/__ink__/index.js";
const encoded = ${JSON.stringify(encoded)};
const files = Object.fromEntries(Object.entries(encoded).map(([file, base64]) => [file, Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]));
const canvas = document.querySelector("#ink");
const heartbeatGaps = [];
let lastHeartbeat = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  heartbeatGaps.push(now - lastHeartbeat);
  lastHeartbeat = now;
}, 50);
try {
  console.info("[resize-probe] create:start");
  configNavigatorHost();
  const view = await createInkView({
    width: 448,
    height: 150,
    scaleFactor: 1,
    canvas,
    hostCapabilities: { speech: { startRecognition() {}, stopRecognition() {}, abortRecognition() {}, speak() {} } }
  });
  console.info("[resize-probe] create:completed");
  view.openBundle({
    appId: "rabilink-aiui-resize-${mode}",
    files,
    query: ${mode === "configuration"
      ? '{ mode: "configuration", surface: "config", panel: "tools" }'
      : '{ mode: "transcription" }'}
  });
  console.info("[resize-probe] openBundle:return");
  view.startRendering();
  console.info("[resize-probe] rendering:started");
  setTimeout(() => {
    console.info("[resize-probe] enter:start");
    view.setInteractive(true);
    document.querySelector("#modalHost").appendChild(canvas);
    requestAnimationFrame(() => {
      console.info("[resize-probe] enter:frame1");
      const resizeStartedAt = performance.now();
      canvas.style.width = "480px";
      canvas.style.height = "352px";
      canvas.style.minWidth = "480px";
      canvas.style.minHeight = "352px";
      canvas.style.maxWidth = "480px";
      canvas.style.maxHeight = "352px";
      canvas.width = 480;
      canvas.height = 352;
      view.setLayoutMode("bounded");
      console.info("[resize-probe] resize:call");
      view.resize(480, 352, { layoutMode: "bounded", scaleFactor: 1, resetScroll: false });
      console.info("[resize-probe] resize:return");
      view.requestRender();
      const resizeReturnMs = performance.now() - resizeStartedAt;
      requestAnimationFrame(async () => {
        canvas.style.width = "480px";
        canvas.style.height = "352px";
        await new Promise((resolve) => setTimeout(resolve, 300));
        const firstKey = ${mode === "configuration" ? '"ArrowUp"' : '"ArrowDown"'};
        const secondKey = ${mode === "configuration" ? '"ArrowDown"' : '"ArrowUp"'};
        let modeRoundTrips = 0;
        for (let index = 0; index < 20; index += 1) {
          let timestamp = Date.now();
          view.dispatchInput("keydown", firstKey, timestamp);
          view.dispatchInput("keyup", firstKey, timestamp + 1);
          await new Promise((resolve) => setTimeout(resolve, 25));
          timestamp = Date.now();
          view.dispatchInput("keydown", secondKey, timestamp);
          view.dispatchInput("keyup", secondKey, timestamp + 1);
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!view.isRunning() || view.isCloseRequested()) break;
          modeRoundTrips += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        clearInterval(heartbeat);
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let litPixels = 0;
        let firstLitY = canvas.height;
        let lastLitY = -1;
        const rowBands = {
          header: 0,
          mode: 0,
          status: 0,
          message: 0,
          footer: 0
        };
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset] <= 8 && pixels[offset + 1] <= 8 && pixels[offset + 2] <= 8) continue;
          litPixels += 1;
          const pixelIndex = offset / 4;
          const y = Math.floor(pixelIndex / canvas.width);
          firstLitY = Math.min(firstLitY, y);
          lastLitY = Math.max(lastLitY, y);
          if (y >= 248 && y <= 265) rowBands.header += 1;
          else if (y >= 266 && y <= 289) rowBands.mode += 1;
          else if (y >= 290 && y <= 306) rowBands.status += 1;
          else if (y >= 307 && y <= 323) rowBands.message += 1;
          else if (y >= 324 && y <= 341) rowBands.footer += 1;
        }
        globalThis.__interactiveResize = {
          ok: view.isRunning(),
          closeRequested: view.isCloseRequested(),
          width: canvas.width,
          height: canvas.height,
          resizeReturnMs: Math.round(resizeReturnMs),
          maxHeartbeatGapMs: Math.round(Math.max(0, ...heartbeatGaps)),
          heartbeatCount: heartbeatGaps.length,
          modeRoundTrips,
          litPixels,
          firstLitY,
          lastLitY,
          rowBands
        };
        console.info("[resize-probe] completed");
      });
    });
  }, 500);
} catch (error) {
  clearInterval(heartbeat);
  globalThis.__interactiveResize = { ok: false, error: error?.stack || String(error) };
}
</script></body></html>`;
}

function timeoutAfter(delayMs, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${delayMs}ms.`)), delayMs);
  });
}

function startServer(html) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (url.pathname.startsWith("/__ink__/")) {
      const relative = decodeURIComponent(url.pathname.slice("/__ink__/".length)).replaceAll("/", path.sep);
      const file = path.resolve(inkRoot, relative);
      const check = path.relative(inkRoot, file);
      if (check && !check.startsWith("..") && !path.isAbsolute(check) && fs.existsSync(file)) {
        response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
        fs.createReadStream(file).pipe(response);
        return;
      }
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(candidate));
let server;
let browser;
const logs = [];
const errors = [];
let result = null;
let caughtError = null;
try {
  if (!executablePath) throw new Error("Chrome was not found.");
  await buildPackageStaging(stagingRoot);
  server = await startServer(harnessHtml(collectBundleFiles(stagingRoot), resizeMode));
  const address = server.address();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      `--explicitly-allowed-ports=${address.port}`
    ]
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 352 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    const line = `${message.type()}: ${message.text()}`;
    logs.push(line);
    if (/resize-probe|LayoutEngine|apply_ops|child_sync_parents/i.test(line)) console.log(line);
  });
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await Promise.race([
    page.waitForFunction(() => globalThis.__interactiveResize, null, { timeout: 12000 }),
    timeoutAfter(14000, "Interactive resize probe")
  ]);
  result = await page.evaluate(() => globalThis.__interactiveResize);
  await page.locator("#ink").screenshot({ path: screenshotPath });
  const runtimeDiagnostics = logs.filter((line) => /apply_ops is still spinning|child_sync_parents|Attempted to add node as its own child|LayoutEngine::set_children/i.test(line));
  const sharedHudComplete = result?.firstLitY >= 240
    && result?.lastLitY >= 330
    && result?.rowBands?.header > 150
    && result?.rowBands?.mode > 750
    && result?.rowBands?.status > 250
    && result?.rowBands?.message > 350
    && result?.rowBands?.footer > 150;
  if (!result?.ok || result.closeRequested || result.modeRoundTrips !== 20 || result.width !== 480 || result.height !== 352 || result.resizeReturnMs > 1000 || result.maxHeartbeatGapMs > 1500 || result.litPixels < 500 || !sharedHudComplete || runtimeDiagnostics.length || errors.length) {
    throw new Error(`Interactive resize failed: ${JSON.stringify({ resizeMode, result, runtimeDiagnostics, errors })}`);
  }
  console.log(`RabiLink AIUI ${resizeMode} interactive resize passed on Ink ${inkVersion} (${result.resizeReturnMs}ms resize, ${result.maxHeartbeatGapMs}ms max heartbeat gap, ${result.modeRoundTrips} mode round trips).`);
} catch (error) {
  caughtError = error;
} finally {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), inkPackage, inkVersion, resizeMode, result, error: caughtError?.stack || null, errors, relevantLogs: logs.filter((line) => /resize-probe|apply_ops|child_sync_parents|LayoutEngine|set_children|resize|open_bundle|pages\/config|error/i.test(line)).slice(-240) }, null, 2)}\n`, "utf8");
  await Promise.race([browser?.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
  await new Promise((resolve) => server?.close(resolve) || resolve());
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
if (caughtError) throw caughtError;

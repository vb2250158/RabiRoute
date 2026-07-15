import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const inkRoot = path.join(projectRoot, "node_modules", "@yodaos-pkg", "ink");
const stagingRoot = path.join(os.tmpdir(), `rabilink-aiui-startup-safety-${process.pid}-${Date.now()}`);
const soakMode = process.argv.includes("--soak");
const testDurationMs = soakMode ? 21500 : 3200;
const reportPath = path.join(projectRoot, "dist", soakMode ? "ink-startup-soak.json" : "ink-startup-safety.json");

function fail(message) {
  throw new Error(message);
}

function collectBundleFiles(root, relative = "") {
  const files = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, collectBundleFiles(root, nextRelative));
    } else if (entry.isFile()) {
      files[nextRelative.replaceAll("\\", "/")] = fs.readFileSync(path.join(root, nextRelative)).toString("base64");
    }
  }
  return files;
}

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function harnessHtml(encoded, durationMs) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="preview" width="448" height="150"></canvas><canvas id="runtime" width="480" height="352"></canvas>
<script type="module">
import { configNavigatorHost, createInkView } from "/__ink__/index.js";
const encoded = ${JSON.stringify(encoded)};
const files = Object.fromEntries(Object.entries(encoded).map(([file, base64]) => [file, Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]));
const previewStarts = [];
const runtimeStarts = [];
let previewView;
let runtimeView;
let previewOpenBundleMs = 0;
let runtimeOpenBundleMs = 0;
const heartbeatGaps = [];
let lastHeartbeat = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  heartbeatGaps.push(now - lastHeartbeat);
  lastHeartbeat = now;
}, 50);

function unstableSpeech(viewFor, starts, errorFirst = false) {
  return {
    startRecognition(request) {
      starts.push(Date.now());
      setTimeout(() => {
        const target = viewFor().getHostCapabilitiesTarget();
        if (errorFirst && starts.length === 1) {
          target.dispatchEvent(new CustomEvent("speech.error", {
            detail: {
              targetId: request.targetId,
              sessionId: request.sessionId,
              error: "network",
              message: "Craft preview ASR unavailable"
            }
          }));
          return;
        }
        target.dispatchEvent(new CustomEvent("speech.end", {
          detail: { targetId: request.targetId, sessionId: request.sessionId }
        }));
      }, 80);
    },
    stopRecognition() {},
    abortRecognition() {},
    speak() {}
  };
}

try {
  configNavigatorHost();
  previewView = await createInkView({
    width: 448,
    height: 150,
    scaleFactor: 1,
    canvas: document.querySelector("#preview"),
    hostCapabilities: { speech: unstableSpeech(() => previewView, previewStarts) }
  });
  const previewOpenStartedAt = performance.now();
  previewView.openBundle({
    appId: "rabilink-aiui-preview",
    files,
    query: { mode: "transcription" }
  });
  previewOpenBundleMs = performance.now() - previewOpenStartedAt;
  previewView.startRendering();

  configNavigatorHost("ROKID-SOAK-DEVICE", "YodaOS Sprite", "aarch64", ["zh-CN"], "CN");
  runtimeView = await createInkView({
    width: 480,
    height: 352,
    scaleFactor: 1,
    canvas: document.querySelector("#runtime"),
    hostCapabilities: { speech: unstableSpeech(() => runtimeView, runtimeStarts, true) }
  });
  const runtimeOpenStartedAt = performance.now();
  runtimeView.openBundle({
    appId: "rabilink-aiui-runtime",
    files,
    query: { mode: "transcription" }
  });
  runtimeOpenBundleMs = performance.now() - runtimeOpenStartedAt;
  runtimeView.startRendering();

  setTimeout(() => {
    clearInterval(heartbeat);
    globalThis.__startupSafety = {
      ok: previewView.isRunning() && runtimeView.isRunning(),
      previewStarts: previewStarts.length,
      runtimeStarts: runtimeStarts.length,
      previewIntervals: previewStarts.slice(1).map((value, index) => value - previewStarts[index]),
      runtimeIntervals: runtimeStarts.slice(1).map((value, index) => value - runtimeStarts[index]),
      previewOpenBundleMs: Math.round(previewOpenBundleMs),
      runtimeOpenBundleMs: Math.round(runtimeOpenBundleMs),
      maxHeartbeatGapMs: Math.round(Math.max(0, ...heartbeatGaps)),
      heartbeatCount: heartbeatGaps.length
    };
  }, ${JSON.stringify(durationMs)});
} catch (error) {
  clearInterval(heartbeat);
  globalThis.__startupSafety = { ok: false, error: error?.stack || String(error) };
}
</script></body></html>`;
}

function startServer(html) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname.startsWith("/__ink__/")) {
      const relative = decodeURIComponent(url.pathname.slice("/__ink__/".length)).replaceAll("/", path.sep);
      const file = path.resolve(inkRoot, relative);
      const relativeCheck = path.relative(inkRoot, file);
      if (relativeCheck && !relativeCheck.startsWith("..") && !path.isAbsolute(relativeCheck) && fs.existsSync(file) && fs.statSync(file).isFile()) {
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

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

let server;
let browser;
try {
  await buildPackageStaging(stagingRoot);
  const encoded = collectBundleFiles(stagingRoot);
  server = await startServer(harnessHtml(encoded, testDurationMs));
  const address = server.address();
  const executablePath = chromeExecutable();
  if (!executablePath) fail("Chrome was not found. Set CHROME_PATH to run the Ink startup safety test.");

  const logs = [];
  const pageErrors = [];
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
  const page = await browser.newPage({ viewport: { width: 480, height: 502 }, deviceScaleFactor: 1 });
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => globalThis.__startupSafety, null, { timeout: testDurationMs + 10000 });
  const result = await page.evaluate(() => globalThis.__startupSafety);
  const openBundleTotalMs = Number(result?.previewOpenBundleMs || 0) + Number(result?.runtimeOpenBundleMs || 0);
  const heartbeatBudgetMs = Math.max(2000, openBundleTotalMs + 500);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: soakMode ? "soak" : "quick",
    durationMs: testDurationMs,
    result,
    budgets: {
      perOpenBundleMs: 1000,
      combinedOpenBundleMs: 1400,
      heartbeatGapMs: heartbeatBudgetMs
    },
    errors: pageErrors,
    relevantLogs: logs.filter((line) => /speech|recognition|error|failed/i.test(line)).slice(-80)
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const minimumRuntimeStarts = soakMode ? 5 : 2;
  const maximumRuntimeStarts = soakMode ? 5 : 3;
  const startupSafe = result?.ok === true
    && result.previewStarts === 0
    && result.runtimeStarts >= minimumRuntimeStarts
    && result.runtimeStarts <= maximumRuntimeStarts
    && result.previewOpenBundleMs <= 1000
    && result.runtimeOpenBundleMs <= 1000
    && openBundleTotalMs <= 1400
    && result.maxHeartbeatGapMs <= heartbeatBudgetMs
    && pageErrors.length === 0;
  if (!startupSafe) {
    fail(`RabiLink AIUI startup safety failed: ${JSON.stringify(result)}. Report: ${reportPath}`);
  }
  console.log(`RabiLink AIUI startup ${soakMode ? "soak" : "safety"} passed (preview starts ${result.previewStarts}, runtime starts ${result.runtimeStarts}, max heartbeat gap ${result.maxHeartbeatGapMs}ms).`);
  console.log(`Report: ${reportPath}`);
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve) || resolve());
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

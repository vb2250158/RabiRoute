import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import initAix, { AixReaderWasm } from "@yodaos-pkg/aix/pkg/aix_web.js";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const inkRoot = path.join(projectRoot, "node_modules", "@yodaos-pkg", "ink");
const stagingRoot = path.join(os.tmpdir(), `rabilink-aiui-ink-smoke-${process.pid}-${Date.now()}`);
const aixArgumentIndex = process.argv.indexOf("--aix");
const aixInputPath = aixArgumentIndex >= 0
  ? path.resolve(process.argv[aixArgumentIndex + 1] || "")
  : "";
const runtimeToken = String(process.env.RABILINK_AIUI_INK_TOKEN || "").trim();
const testBatteryLevelText = String(process.env.RABILINK_AIUI_INK_BATTERY_LEVEL || "").trim();
const testBatteryChargingText = String(process.env.RABILINK_AIUI_INK_BATTERY_CHARGING || "").trim().toLowerCase();
const testFontScale = Number(String(process.env.RABILINK_AIUI_INK_FONT_SCALE || "1").trim());
const testBatteryFixture = testBatteryLevelText
  ? {
      batteryLevel: Number(testBatteryLevelText),
      charging: ["1", "true", "yes", "charging"].includes(testBatteryChargingText)
    }
  : null;
if (testBatteryFixture && (!Number.isFinite(testBatteryFixture.batteryLevel)
  || testBatteryFixture.batteryLevel < 0
  || testBatteryFixture.batteryLevel > 100)) {
  throw new Error("RABILINK_AIUI_INK_BATTERY_LEVEL must be between 0 and 100.");
}
if (aixInputPath && testBatteryFixture) {
  throw new Error("The Ink battery fixture is source-build-only and cannot alter a delivery AIX.");
}
if (!Number.isFinite(testFontScale) || testFontScale < 1 || testFontScale > 1.4) {
  throw new Error("RABILINK_AIUI_INK_FONT_SCALE must be between 1 and 1.4.");
}
if (aixInputPath && testFontScale !== 1) {
  throw new Error("The Ink font-scale fixture is source-build-only and cannot alter a delivery AIX.");
}
const screenshotVariant = `${testBatteryFixture ? "-charging" : ""}${testFontScale === 1 ? "" : `-font-${Math.round(testFontScale * 100)}`}`;
const screenshotPath = path.join(projectRoot, "dist", `ink-runtime${screenshotVariant}-smoke.png`);
const configurationScreenshotPath = path.join(projectRoot, "dist", `ink-runtime-swipe${screenshotVariant}-smoke.png`);
const compactScreenshotPath = path.join(projectRoot, "dist", `ink-runtime-compact${screenshotVariant}-smoke.png`);
const compactConfigurationScreenshotPath = path.join(projectRoot, "dist", `ink-runtime-compact-configuration${screenshotVariant}-smoke.png`);
const toolsPageOneScreenshotPath = path.join(projectRoot, "dist", `ink-runtime-tools-page-1${screenshotVariant}.png`);
const toolsPageTwoScreenshotPath = path.join(projectRoot, "dist", `ink-runtime-tools-page-2${screenshotVariant}.png`);

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

async function collectAixFiles(aixPath) {
  if (!fs.existsSync(aixPath)) fail(`AIX not found: ${aixPath}`);
  const wasmPath = path.join(projectRoot, "node_modules", "@yodaos-pkg", "aix", "pkg", "aix_web_bg.wasm");
  await initAix({ module_or_path: fs.readFileSync(wasmPath) });
  const reader = new AixReaderWasm(fs.readFileSync(aixPath));
  try {
    return Object.fromEntries(reader.list().map((entry) => [
      entry.name,
      Buffer.from(reader.read_file(entry.name)).toString("base64")
    ]));
  } finally {
    reader.free();
  }
}

function applyTestBatteryFixture(stagingRoot) {
  if (!testBatteryFixture) return;
  const pageScriptPath = path.join(stagingRoot, "pages", "home", "index.js");
  const marker = "async resolveBatterySnapshot() {";
  const source = fs.readFileSync(pageScriptPath, "utf8");
  const markerCount = source.split(marker).length - 1;
  if (markerCount !== 1) fail(`Expected one battery resolver in compiled page, found ${markerCount}.`);
  const injected = source.replace(
    marker,
    `${marker}\n    if (this.applyBatterySnapshot(${JSON.stringify(testBatteryFixture)}, "ink-test-fixture")) return true;`
  );
  fs.writeFileSync(pageScriptPath, injected, "utf8");
}

function applyTestFontScaleFixture(stagingRoot) {
  if (testFontScale === 1) return;
  const stylePath = path.join(stagingRoot, "pages", "home", "index.wxss");
  const source = fs.readFileSync(stylePath, "utf8");
  const scaled = source.replace(/font-size:\s*([0-9.]+)px;/g, (_, value) => {
    const size = Math.round(Number(value) * testFontScale * 100) / 100;
    return `font-size: ${size}px;`;
  });
  if (scaled === source) fail("Font-scale fixture did not find any font-size declarations.");
  fs.writeFileSync(stylePath, scaled, "utf8");
}

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function harnessHtml(encoded) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}#ink,#tools{width:480px;height:352px}#compact{width:448px;height:150px}</style></head>
<body><canvas id="ink" width="480" height="352"></canvas><canvas id="compact" width="448" height="150"></canvas><canvas id="tools" width="480" height="352"></canvas>
<script type="module">
import { configNavigatorHost, createInkView } from "/__ink__/index.js";
const encoded = ${JSON.stringify(encoded)};
const runtimeToken = ${JSON.stringify(runtimeToken)};
const withRuntimeToken = (query) => runtimeToken ? { ...query, token: runtimeToken } : query;
const files = Object.fromEntries(Object.entries(encoded).map(([file, base64]) => [file, Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]));
try {
  const canvas = document.querySelector("#ink");
  const compactCanvas = document.querySelector("#compact");
  const toolsCanvas = document.querySelector("#tools");
  let view;
  let compactView;
  let toolsView;
  const asrStarts = [];
  const toolsAsrStarts = [];
  const hostCapabilities = {
    speech: {
      startRecognition(request) {
        asrStarts.push(request);
        if (asrStarts.length !== 1) return;
        setTimeout(() => {
          const target = view.getHostCapabilitiesTarget();
          target.dispatchEvent(new CustomEvent("speech.result", {
            detail: {
              targetId: request.targetId,
              sessionId: request.sessionId,
              resultIndex: 0,
              isFinal: true,
              alternatives: [{ transcript: "AIUI 原生 ASR 桥接通过", confidence: 0.99 }]
            }
          }));
          target.dispatchEvent(new CustomEvent("speech.end", {
            detail: { targetId: request.targetId, sessionId: request.sessionId }
          }));
        }, 80);
      },
      stopRecognition() {},
      abortRecognition() {},
      speak() {}
    }
  };
  configNavigatorHost("ROKID-SMOKE-DEVICE", "YodaOS Sprite", "aarch64", ["zh-CN"], "CN");
  view = await createInkView({ width: 480, height: 352, scaleFactor: 1, canvas, hostCapabilities });
  const transcriptionQuery = withRuntimeToken({ mode: "transcription" });
  view.openBundle({ appId: "rabilink-aiui", files, query: transcriptionQuery });
  view.startRendering();
  const compactAsrStarts = [];
  const compactHostCapabilities = {
    speech: {
      startRecognition(request) {
        compactAsrStarts.push(request);
        if (compactAsrStarts.length !== 1) return;
        setTimeout(() => {
          const target = compactView.getHostCapabilitiesTarget();
          target.dispatchEvent(new CustomEvent("speech.result", {
            detail: {
              targetId: request.targetId,
              sessionId: request.sessionId,
              resultIndex: 0,
              isFinal: true,
              alternatives: [{ transcript: "这是一段用于验证非沉浸式入口卡单行省略显示的较长语音转写内容", confidence: 0.99 }]
            }
          }));
          target.dispatchEvent(new CustomEvent("speech.end", {
            detail: { targetId: request.targetId, sessionId: request.sessionId }
          }));
        }, 80);
      },
      stopRecognition() {},
      abortRecognition() {},
      speak() {}
    }
  };
  configNavigatorHost();
  compactView = await createInkView({ width: 448, height: 150, scaleFactor: 1, canvas: compactCanvas, hostCapabilities: compactHostCapabilities });
  compactView.openBundle({ appId: "rabilink-aiui-compact", files, query: withRuntimeToken({ mode: "transcription" }) });
  compactView.startRendering();
  toolsView = await createInkView({
    width: 480,
    height: 352,
    scaleFactor: 1,
    canvas: toolsCanvas,
    hostCapabilities: {
      speech: {
        startRecognition(request) { toolsAsrStarts.push(request); },
        stopRecognition() {},
        abortRecognition() {},
        speak() {}
      }
    }
  });
  toolsView.openBundle({
    appId: "rabilink-aiui-tools",
    files,
    query: withRuntimeToken({ mode: "configuration", surface: "config", panel: "tools" })
  });
  toolsView.startRendering();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const context = canvas.getContext("2d");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let firstLitY = canvas.height;
  let lastLitY = -1;
  let litPixels = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] > 8 || pixels[offset + 1] > 8 || pixels[offset + 2] > 8) {
        firstLitY = Math.min(firstLitY, y);
        lastLitY = Math.max(lastLitY, y);
        litPixels += 1;
      }
    }
  }
  const compactContext = compactCanvas.getContext("2d");
  const compactPixels = compactContext.getImageData(0, 0, compactCanvas.width, compactCanvas.height).data;
  let compactFirstLitY = compactCanvas.height;
  let compactLastLitY = -1;
  let compactLitPixels = 0;
  for (let y = 0; y < compactCanvas.height; y += 1) {
    for (let x = 0; x < compactCanvas.width; x += 1) {
      const offset = (y * compactCanvas.width + x) * 4;
      if (compactPixels[offset] > 8 || compactPixels[offset + 1] > 8 || compactPixels[offset + 2] > 8) {
        compactFirstLitY = Math.min(compactFirstLitY, y);
        compactLastLitY = Math.max(compactLastLitY, y);
        compactLitPixels += 1;
      }
    }
  }
  const toolsContext = toolsCanvas.getContext("2d");
  const toolsPageOnePixels = toolsContext.getImageData(0, 0, toolsCanvas.width, toolsCanvas.height).data;
  let toolsPageOneLitPixels = 0;
  for (let offset = 0; offset < toolsPageOnePixels.length; offset += 4) {
    if (toolsPageOnePixels[offset] > 8 || toolsPageOnePixels[offset + 1] > 8 || toolsPageOnePixels[offset + 2] > 8) toolsPageOneLitPixels += 1;
  }
  globalThis.__smoke = {
    ok: view.isRunning(),
    invocationHasToken: Object.prototype.hasOwnProperty.call(transcriptionQuery, "token"),
    pngLength: canvas.toDataURL("image/png").length,
    asrStarts: asrStarts.length,
    firstAsrRequest: asrStarts[0] || null,
    firstLitY,
    lastLitY,
    litPixels,
    compactRunning: compactView.isRunning(),
    compactAsrStarts: compactAsrStarts.length,
    compactPngLength: compactCanvas.toDataURL("image/png").length,
    compactFirstLitY,
    compactLastLitY,
    compactLitPixels,
    toolsRunning: toolsView.isRunning(),
    toolsPageOneLitPixels
  };
  globalThis.__dispatchToolsPageDown = async () => {
    toolsView.setInteractive(true);
    const timestamp = Date.now();
    toolsView.dispatchInput("keydown", "ArrowDown", timestamp);
    toolsView.dispatchInput("keyup", "ArrowDown", timestamp + 1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const afterPixels = toolsContext.getImageData(0, 0, toolsCanvas.width, toolsCanvas.height).data;
    let changedPixels = 0;
    let litPixelsAfter = 0;
    for (let offset = 0; offset < afterPixels.length; offset += 4) {
      if (afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8) litPixelsAfter += 1;
      if (afterPixels[offset] !== toolsPageOnePixels[offset]
        || afterPixels[offset + 1] !== toolsPageOnePixels[offset + 1]
        || afterPixels[offset + 2] !== toolsPageOnePixels[offset + 2]) changedPixels += 1;
    }
    return {
      running: toolsView.isRunning(),
      changedPixels,
      litPixels: litPixelsAfter,
      pngLength: toolsCanvas.toDataURL("image/png").length,
      asrStarts: toolsAsrStarts.length
    };
  };
  globalThis.__probeToolsFrameStability = async (durationMs = 1200) => {
    const startedAt = performance.now();
    const fullThreshold = Math.max(500, Math.floor(toolsPageOneLitPixels * 0.7));
    let samples = 0;
    let blackFrames = 0;
    let partialFrames = 0;
    let minLitPixels = Number.POSITIVE_INFINITY;
    let maxLitPixels = 0;
    while (performance.now() - startedAt < durationMs) {
      const pixels = toolsContext.getImageData(0, 0, toolsCanvas.width, toolsCanvas.height).data;
      let litPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset] > 8 || pixels[offset + 1] > 8 || pixels[offset + 2] > 8) litPixels += 1;
      }
      samples += 1;
      minLitPixels = Math.min(minLitPixels, litPixels);
      maxLitPixels = Math.max(maxLitPixels, litPixels);
      if (litPixels < 20) blackFrames += 1;
      else if (litPixels < fullThreshold) partialFrames += 1;
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    return {
      samples,
      blackFrames,
      partialFrames,
      minLitPixels: Number.isFinite(minLitPixels) ? minLitPixels : 0,
      maxLitPixels,
      fullThreshold
    };
  };
  globalThis.__dispatchToolsSwitchToTranscription = async () => {
    const timestamp = Date.now();
    toolsView.dispatchInput("keydown", "ArrowUp", timestamp);
    toolsView.dispatchInput("keyup", "ArrowUp", timestamp + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const afterPixels = toolsContext.getImageData(0, 0, toolsCanvas.width, toolsCanvas.height).data;
    let litPixelsAfter = 0;
    for (let offset = 0; offset < afterPixels.length; offset += 4) {
      if (afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8) litPixelsAfter += 1;
    }
    return {
      running: toolsView.isRunning(),
      closeRequested: toolsView.isCloseRequested(),
      litPixels: litPixelsAfter,
      asrStarts: toolsAsrStarts.length
    };
  };
  globalThis.__dispatchSwipeDown = async () => {
    const timestamp = Date.now();
    view.dispatchInput("keydown", "ArrowDown", timestamp);
    view.dispatchInput("keyup", "ArrowDown", timestamp + 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let firstLitYAfter = canvas.height;
    let lastLitYAfter = -1;
    let firstLitXAfter = canvas.width;
    let lastLitXAfter = -1;
    let litPixelsAfter = 0;
    let changedPixels = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8) {
          firstLitXAfter = Math.min(firstLitXAfter, x);
          lastLitXAfter = Math.max(lastLitXAfter, x);
          firstLitYAfter = Math.min(firstLitYAfter, y);
          lastLitYAfter = Math.max(lastLitYAfter, y);
          litPixelsAfter += 1;
        }
        if (afterPixels[offset] !== pixels[offset]
          || afterPixels[offset + 1] !== pixels[offset + 1]
          || afterPixels[offset + 2] !== pixels[offset + 2]) changedPixels += 1;
      }
    }
    let modeProductLitPixels = 0;
    let unsafeEdgeLitPixels = 0;
    const modeHeaderBottom = Math.min(canvas.height, firstLitYAfter + 32);
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const lit = afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8;
        if (!lit) continue;
        if (x < 12 || x >= canvas.width - 12) unsafeEdgeLitPixels += 1;
        if (x >= 12 && x < 80 && y >= firstLitYAfter && y < modeHeaderBottom) modeProductLitPixels += 1;
      }
    }
    return {
      closeRequested: view.isCloseRequested(),
      running: view.isRunning(),
      asrStarts: asrStarts.length,
      firstLitX: firstLitXAfter,
      lastLitX: lastLitXAfter,
      firstLitY: firstLitYAfter,
      lastLitY: lastLitYAfter,
      litPixels: litPixelsAfter,
      changedPixels,
      modeProductLitPixels,
      unsafeEdgeLitPixels
    };
  };
  globalThis.__dispatchSwipeUp = async () => {
    const timestamp = Date.now();
    view.dispatchInput("keydown", "ArrowUp", timestamp);
    view.dispatchInput("keyup", "ArrowUp", timestamp + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const afterPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let firstLitYAfter = canvas.height;
    let lastLitYAfter = -1;
    let litPixelsAfter = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8) {
          firstLitYAfter = Math.min(firstLitYAfter, y);
          lastLitYAfter = Math.max(lastLitYAfter, y);
          litPixelsAfter += 1;
        }
      }
    }
    return {
      closeRequested: view.isCloseRequested(),
      running: view.isRunning(),
      firstLitY: firstLitYAfter,
      lastLitY: lastLitYAfter,
      litPixels: litPixelsAfter
    };
  };
  globalThis.__dispatchModeStress = async (cycles = 20) => {
    const litPixelCount = () => {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset] > 8 || pixels[offset + 1] > 8 || pixels[offset + 2] > 8) count += 1;
      }
      return count;
    };
    const baselineLitPixels = litPixelCount();
    let minimumTransitionLitPixels = baselineLitPixels;
    for (let index = 0; index < cycles; index += 1) {
      let timestamp = Date.now();
      view.dispatchInput("keydown", "ArrowDown", timestamp);
      view.dispatchInput("keyup", "ArrowDown", timestamp + 1);
      await new Promise((resolve) => setTimeout(resolve, 8));
      minimumTransitionLitPixels = Math.min(minimumTransitionLitPixels, litPixelCount());
      await new Promise((resolve) => setTimeout(resolve, 27));
      timestamp = Date.now();
      view.dispatchInput("keydown", "ArrowUp", timestamp);
      view.dispatchInput("keyup", "ArrowUp", timestamp + 1);
      await new Promise((resolve) => setTimeout(resolve, 8));
      minimumTransitionLitPixels = Math.min(minimumTransitionLitPixels, litPixelCount());
      await new Promise((resolve) => setTimeout(resolve, 27));
      if (!view.isRunning() || view.isCloseRequested()) return {
        running: view.isRunning(),
        closeRequested: view.isCloseRequested(),
        completed: index,
        baselineLitPixels,
        minimumTransitionLitPixels
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      running: view.isRunning(),
      closeRequested: view.isCloseRequested(),
      completed: cycles,
      baselineLitPixels,
      minimumTransitionLitPixels
    };
  };
  globalThis.__dispatchCompactSwipeDown = async () => {
    const timestamp = Date.now();
    compactView.dispatchInput("keydown", "ArrowDown", timestamp);
    compactView.dispatchInput("keyup", "ArrowDown", timestamp + 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterPixels = compactContext.getImageData(0, 0, compactCanvas.width, compactCanvas.height).data;
    let firstLitYAfter = compactCanvas.height;
    let lastLitYAfter = -1;
    let litPixelsAfter = 0;
    for (let y = 0; y < compactCanvas.height; y += 1) {
      for (let x = 0; x < compactCanvas.width; x += 1) {
        const offset = (y * compactCanvas.width + x) * 4;
        if (afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8) {
          firstLitYAfter = Math.min(firstLitYAfter, y);
          lastLitYAfter = Math.max(lastLitYAfter, y);
          litPixelsAfter += 1;
        }
      }
    }
    return {
      closeRequested: compactView.isCloseRequested(),
      running: compactView.isRunning(),
      firstLitY: firstLitYAfter,
      lastLitY: lastLitYAfter,
      litPixels: litPixelsAfter
    };
  };
  globalThis.__dispatchCompactSwipeUp = async () => {
    const timestamp = Date.now();
    compactView.dispatchInput("keydown", "ArrowUp", timestamp);
    compactView.dispatchInput("keyup", "ArrowUp", timestamp + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const afterPixels = compactContext.getImageData(0, 0, compactCanvas.width, compactCanvas.height).data;
    let firstLitYAfter = compactCanvas.height;
    let lastLitYAfter = -1;
    let litPixelsAfter = 0;
    for (let y = 0; y < compactCanvas.height; y += 1) {
      for (let x = 0; x < compactCanvas.width; x += 1) {
        const offset = (y * compactCanvas.width + x) * 4;
        if (afterPixels[offset] > 8 || afterPixels[offset + 1] > 8 || afterPixels[offset + 2] > 8) {
          firstLitYAfter = Math.min(firstLitYAfter, y);
          lastLitYAfter = Math.max(lastLitYAfter, y);
          litPixelsAfter += 1;
        }
      }
    }
    return {
      closeRequested: compactView.isCloseRequested(),
      running: compactView.isRunning(),
      firstLitY: firstLitYAfter,
      lastLitY: lastLitYAfter,
      litPixels: litPixelsAfter
    };
  };
  globalThis.__dispatchCompactVoiceWakeup = async () => {
    compactView.setInteractive(true);
    const handled = compactView.dispatchVoiceWakeup("leqi", Date.now());
    await new Promise((resolve) => setTimeout(resolve, 180));
    return {
      handled,
      asrStarts: compactAsrStarts.length
    };
  };
} catch (error) {
  globalThis.__smoke = { ok: false, error: error?.stack || String(error) };
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

async function writeFrozenCanvasPng(page, selector, outputPath) {
  const dataUrl = await page.locator(selector).evaluate((canvas) => {
    const source = canvas.getContext("2d");
    const frame = source.getImageData(0, 0, canvas.width, canvas.height);
    const frozen = document.createElement("canvas");
    frozen.width = canvas.width;
    frozen.height = canvas.height;
    frozen.getContext("2d").putImageData(frame, 0, 0);
    return frozen.toDataURL("image/png");
  });
  const encoded = String(dataUrl || "").replace(/^data:image\/png;base64,/, "");
  if (!encoded) fail(`Could not freeze Ink canvas ${selector}.`);
  fs.writeFileSync(outputPath, Buffer.from(encoded, "base64"));
}

let server;
let browser;
try {
  let encoded;
  if (aixInputPath) encoded = await collectAixFiles(aixInputPath);
  else {
    await buildPackageStaging(stagingRoot);
    applyTestBatteryFixture(stagingRoot);
    applyTestFontScaleFixture(stagingRoot);
    encoded = collectBundleFiles(stagingRoot);
  }
  server = await startServer(harnessHtml(encoded));
  const address = server.address();
  const executablePath = chromeExecutable();
  if (!executablePath) fail("Chrome was not found. Set CHROME_PATH to run the real Ink smoke test.");

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
  const page = await browser.newPage({ viewport: { width: 480, height: 520 }, deviceScaleFactor: 1 });
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => globalThis.__smoke, null, { timeout: 15000 });
  const result = await page.evaluate(() => globalThis.__smoke);
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await writeFrozenCanvasPng(page, "#ink", screenshotPath);
  await writeFrozenCanvasPng(page, "#compact", compactScreenshotPath);
  await writeFrozenCanvasPng(page, "#tools", toolsPageOneScreenshotPath);
  const toolsPageDownResult = await page.evaluate(() => globalThis.__dispatchToolsPageDown());
  const toolsFrameStability = await page.evaluate(() => globalThis.__probeToolsFrameStability());
  await writeFrozenCanvasPng(page, "#tools", toolsPageTwoScreenshotPath);
  const toolsTranscriptionResult = await page.evaluate(() => globalThis.__dispatchToolsSwitchToTranscription());
  const compactWakeupResult = await page.evaluate(() => globalThis.__dispatchCompactVoiceWakeup());
  const swipeResult = await page.evaluate(() => globalThis.__dispatchSwipeDown());
  if (swipeResult?.running) {
    await writeFrozenCanvasPng(page, "#ink", configurationScreenshotPath);
  }
  const compactSwipeResult = await page.evaluate(() => globalThis.__dispatchCompactSwipeDown());
  if (compactSwipeResult?.running) {
    await writeFrozenCanvasPng(page, "#compact", compactConfigurationScreenshotPath);
  }
  const swipeReturnResult = await page.evaluate(() => globalThis.__dispatchSwipeUp());
  const compactSwipeReturnResult = await page.evaluate(() => globalThis.__dispatchCompactSwipeUp());
  const modeStressResult = await page.evaluate(() => globalThis.__dispatchModeStress(20));

  const joined = [...logs, ...pageErrors].join("\n");
  const required = [
    "JsRuntime::eval_module namespace success module='/__ink_bundle__/rabilink-aiui/app.js'",
    "JsRuntime::eval_module namespace success module='/__ink_bundle__/rabilink-aiui/pages/home/index.js'",
    "InkWebView::open_bundle completed"
  ];
  const forbidden = /Module not found|Builtin module not found|Error running (?:page|component)|Exported default must be an object|Failed to execute page|JsRuntime::eval_module declare failed/;
  const asrContractOk = result?.asrStarts >= 2
    && result?.firstAsrRequest?.continuous === false
    && result?.firstAsrRequest?.interimResults === false;
  const tokenInvocationOk = result?.invocationHasToken === Boolean(runtimeToken);
  const hudLayoutOk = result?.firstLitY >= 240
    && result?.lastLitY >= 330
    && result?.litPixels > 500;
  const compactLayoutOk = result?.compactRunning === true
    && result?.compactAsrStarts === 0
    && result?.compactPngLength > 1000
    && result?.compactFirstLitY <= 12
    && result?.compactLastLitY <= 100
    && result?.compactLitPixels > 300;
  const compactInteractiveAsrOk = compactWakeupResult?.handled === true
    && compactWakeupResult?.asrStarts >= 1;
  const assistantGestureOk = result?.toolsRunning === true
    && result?.toolsPageOneLitPixels > 500
    && toolsPageDownResult?.running === true
    && toolsPageDownResult?.changedPixels > 300
    && toolsPageDownResult?.changedPixels < 3000
    && toolsPageDownResult?.litPixels > 500
    && toolsPageDownResult?.pngLength > 1000
    && toolsPageDownResult?.asrStarts === 0
    && toolsFrameStability?.blackFrames === 0
    && toolsFrameStability?.partialFrames === 0
    && toolsTranscriptionResult?.running === true
    && toolsTranscriptionResult?.closeRequested === false
    && toolsTranscriptionResult?.litPixels > 500
    && toolsTranscriptionResult?.asrStarts === 0;
  const switchedToConfigurationUi = swipeResult?.running === true
    && swipeResult?.closeRequested === false
    && swipeResult?.asrStarts > result?.asrStarts
    && swipeResult?.firstLitX >= 12
    && swipeResult?.lastLitX <= 467
    && swipeResult?.firstLitY >= 240
    && swipeResult?.changedPixels > 300
    && swipeResult?.litPixels > 500
    && swipeResult?.modeProductLitPixels > 250
    && swipeResult?.unsafeEdgeLitPixels === 0;
  const returnedToTranscription = swipeReturnResult?.running === true
    && swipeReturnResult?.closeRequested === false
    && swipeReturnResult?.firstLitY >= 240
    && swipeReturnResult?.lastLitY >= 330
    && swipeReturnResult?.litPixels > 500;
  const compactConfigurationOk = compactSwipeResult?.running === true
    && compactSwipeResult?.closeRequested === false
    && compactSwipeResult?.firstLitY <= 12
    && compactSwipeResult?.lastLitY <= 100
    && compactSwipeResult?.litPixels > 300;
  const compactReturnedOk = compactSwipeReturnResult?.running === true
    && compactSwipeReturnResult?.closeRequested === false
    && compactSwipeReturnResult?.firstLitY <= 12
    && compactSwipeReturnResult?.lastLitY <= 100
    && compactSwipeReturnResult?.litPixels > 300;
  const stressOk = modeStressResult?.running === true
    && modeStressResult?.closeRequested === false
    && modeStressResult?.completed === 20
    && modeStressResult?.minimumTransitionLitPixels > 300;
  if (!result?.ok || !tokenInvocationOk || !asrContractOk || !hudLayoutOk || !compactLayoutOk || !compactInteractiveAsrOk || !assistantGestureOk || !switchedToConfigurationUi || !returnedToTranscription || !compactConfigurationOk || !compactReturnedOk || !stressOk || required.some((line) => !joined.includes(line)) || forbidden.test(joined)) {
    fail(`Real Ink runtime smoke failed.\nresult=${JSON.stringify(result)}\nassistantGesture=${JSON.stringify(toolsPageDownResult)}\ntoolsFrameStability=${JSON.stringify(toolsFrameStability)}\ntoolsTranscription=${JSON.stringify(toolsTranscriptionResult)}\ncompactWakeup=${JSON.stringify(compactWakeupResult)}\nswipe=${JSON.stringify(swipeResult)}\nswipeReturn=${JSON.stringify(swipeReturnResult)}\ncompactSwipe=${JSON.stringify(compactSwipeResult)}\ncompactReturn=${JSON.stringify(compactSwipeReturnResult)}\nstress=${JSON.stringify(modeStressResult)}\n${joined.slice(-12000)}`);
  }
  const templateWarningLimits = new Map([
    ["item.active ? 'segmentOn' : ''", 84],
    ["item.id", 84],
    ["item.text", 18]
  ]);
  const templateWarnings = logs
    .map((line) => line.match(/Template variable '(.+)' is missing from data/))
    .filter(Boolean)
    .map((match) => match[1]);
  const templateWarningCounts = new Map();
  for (const expression of templateWarnings) {
    templateWarningCounts.set(expression, (templateWarningCounts.get(expression) || 0) + 1);
  }
  for (const [expression, count] of templateWarningCounts) {
    const limit = templateWarningLimits.get(expression);
    if (limit == null || count > limit) {
      fail(`Unexpected Ink template warning '${expression}' x${count}.`);
    }
  }
  console.log(`RabiLink AIUI ${aixInputPath ? "delivery AIX" : "source build"} real Ink runtime smoke passed (${result.pngLength} HUD PNG chars, compact ${result.compactPngLength}, 20 same-page mode round trips).`);
  console.log(`Configuration frame stability passed (${toolsFrameStability.samples} samples, ${toolsFrameStability.blackFrames} black, ${toolsFrameStability.partialFrames} partial).`);
  if (testBatteryFixture) {
    console.log(`Ink battery render fixture: ${testBatteryFixture.batteryLevel}%, charging=${testBatteryFixture.charging}.`);
  }
  console.log(`Known Ink list-scope diagnostics: ${JSON.stringify(Object.fromEntries(templateWarningCounts))}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log(`Compact screenshot: ${compactScreenshotPath}`);
  console.log(`Assistant idle screenshot: ${toolsPageOneScreenshotPath}`);
  console.log(`Assistant listening screenshot: ${toolsPageTwoScreenshotPath}`);
  if (compactSwipeResult?.running) console.log(`Compact configuration screenshot: ${compactConfigurationScreenshotPath}`);
  if (swipeResult?.running) console.log(`Swipe screenshot: ${configurationScreenshotPath}`);
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server?.close(resolve) || resolve());
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

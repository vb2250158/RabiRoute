import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const inkRoot = path.resolve(import.meta.dirname, "../node_modules/@yodaos-pkg/ink");
const inkVersion = JSON.parse(fs.readFileSync(path.join(inkRoot, "package.json"), "utf8")).version;
const marker = "INK_NETWORK_PROBE_RESULT=";

// This function is serialized into a Page module and runs inside Ink's JS VM.
// Browser and Node globals are deliberately not injected into that VM.
async function probePage(baseUrl) {
  const result = { globals: {}, checks: {} };
  // Report the hint alongside actual HTTP results; do not use it to skip probes.
  result.networkHint = { online: navigator.onLine, type: navigator.connection?.type };
  for (const name of ["btoa", "atob", "Buffer", "AbortController", "AbortSignal", "fetch", "Headers", "Response", "crypto", "TextEncoder", "TextDecoder"]) {
    result.globals[name] = typeof globalThis[name];
  }
  async function check(name, action) {
    try {
      result.checks[name] = { ok: true, value: await action() };
    } catch (error) {
      result.checks[name] = { ok: false, name: error.name, message: String(error.message) };
    }
  }
  await check("base64", () => {
    const raw = String.fromCharCode(0, 1, 127, 128, 254, 255);
    const encoded = btoa(raw);
    return { encoded, roundTrip: atob(encoded) === raw };
  });
  await check("secureRandom", () => {
    const bytes = new Uint8Array(32);
    const sameObject = crypto.getRandomValues(bytes) === bytes;
    // Only report API shape, never key material or a claim of statistical security.
    return { sameObject, length: bytes.length };
  });
  await check("abortSignal", () => {
    const controller = new AbortController();
    let events = 0;
    controller.signal.addEventListener("abort", () => events++);
    controller.abort();
    return { aborted: controller.signal.aborted, events };
  });
  for (const kind of ["arrayBuffer", "subarray"]) {
    await check(kind + "Post", async () => {
      const bytes = new Uint8Array([99, 0, 1, 127, 128, 254, 255, 88]);
      const view = bytes.subarray(1, 7);
      const body = kind === "arrayBuffer" ? view.slice().buffer : view;
      const response = await fetch(baseUrl + "/echo?kind=" + kind, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body
      });
      const headers = {
        length: response.headers.get("Content-Length"),
        lowerLength: response.headers.get("content-length"),
        probe: response.headers.get("X-Ink-Probe")
      };
      const received = Array.from(new Uint8Array(await response.arrayBuffer()));
      return { status: response.status, headers, received };
    });
  }
  await check("abortFetch", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const response = await fetch(baseUrl + "/slow", { signal: controller.signal });
      await response.arrayBuffer();
      return { rejected: false };
    } catch (error) {
      return { rejected: true, name: error.name, message: String(error.message) };
    } finally {
      clearTimeout(timer);
    }
  });
  console.log("INK_NETWORK_PROBE_RESULT=" + JSON.stringify(result) + "=END_INK_NETWORK_PROBE");
}

const requests = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === "/echo") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ kind: url.searchParams.get("kind"), bytes: Array.from(body) });
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, "X-Ink-Probe": "binary-echo" });
    response.end(body);
    return;
  }
  if (url.pathname === "/slow") {
    const timer = setTimeout(() => response.end("late"), 500);
    response.on("close", () => clearTimeout(timer));
    return;
  }
  if (url.pathname.startsWith("/__ink__/")) {
    const file = path.resolve(inkRoot, decodeURIComponent(url.pathname.slice(9)));
    const relative = path.relative(inkRoot, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    fs.createReadStream(file).pipe(response);
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404).end();
    return;
  }
  const files = {
    "app.json": JSON.stringify({ pages: ["pages/probe/index"] }),
    "app.js": "export default {};",
    "pages/probe/index.js": `${probePage.toString()}\nexport default { onLoad(query) { probePage(query.baseUrl); } };`,
    "pages/probe/index.wxml": "<view>Network capability probe</view>",
    "pages/probe/index.json": "{}"
  };
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><canvas id="ink" width="480" height="352"></canvas>
<script type="module">
import { createInkView } from '/__ink__/index.js';
const files = Object.fromEntries(Object.entries(${JSON.stringify(files)}).map(([name, text]) => [name, new TextEncoder().encode(text)]));
const view = await createInkView({ width: 480, height: 352, canvas: document.querySelector('#ink') });
view.openBundle({ appId: 'ink-network-probe', files, query: { baseUrl: location.origin } });
view.startRendering();
</script>`);
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, "Set CHROME_PATH to run the Ink VM probe.");
  browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
  const page = await browser.newPage();
  const diagnostics = [];
  let result;
  page.on("console", message => {
    const text = message.text();
    const offset = text.indexOf(marker);
    if (offset >= 0) result = JSON.parse(text.slice(offset + marker.length, text.indexOf("=END_INK_NETWORK_PROBE", offset)));
    else if (message.type() === "error") diagnostics.push(text);
  });
  page.on("pageerror", error => diagnostics.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const deadline = Date.now() + 20000;
  while (!result && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(result, "Ink Page did not report results: " + diagnostics.join("\n"));
  console.log(JSON.stringify({ inkVersion, environment: "Ink Page VM in Web/WASM host; no target-device claim", result, serverRequests: requests, diagnostics }, null, 2));
  for (const [name, check] of Object.entries(result.checks)) assert.equal(check.ok, true, name);
  assert.deepEqual(result.checks.base64.value, { encoded: "AAF/gP7/", roundTrip: true });
  assert.deepEqual(result.checks.secureRandom.value, { sameObject: true, length: 32 });
  assert.deepEqual(result.checks.abortSignal.value, { aborted: true, events: 1 });
  assert.equal(result.checks.abortFetch.value.rejected, true);
  assert.equal(result.checks.abortFetch.value.name, "AbortError");
  const expectedBytes = [0, 1, 127, 128, 254, 255];
  for (const kind of ["arrayBuffer", "subarray"]) {
    assert.deepEqual(result.checks[kind + "Post"].value, {
      status: 200,
      headers: { length: "6", lowerLength: "6", probe: "binary-echo" },
      received: expectedBytes
    });
  }
  assert.deepEqual(requests, [
    { kind: "arrayBuffer", bytes: expectedBytes },
    { kind: "subarray", bytes: expectedBytes }
  ]);
  assert.deepEqual(diagnostics, []);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

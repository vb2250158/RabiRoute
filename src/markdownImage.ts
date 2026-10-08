import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Marked } from "./vendor/marked.esm.js";
import WebSocket from "ws";

const IMAGE_WIDTH = 1000;
const MAX_MARKDOWN_BYTES = 32 * 1024;
const MAX_IMAGE_HEIGHT = 4096;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const BROWSER_TIMEOUT_MS = 15_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] || character);
}

const markdownRenderer = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ tokens }) {
      return `<span class="link">${this.parser.parseInline(tokens)}</span>`;
    },
    image({ text }) {
      return `<span class="image-placeholder">图片：${escapeHtml(String(text || "未提供说明"))}</span>`;
    }
  }
});

export function markdownImageHtml(markdown: string): string {
  const content = markdownRenderer.parse(markdown, { async: false });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; connect-src 'none'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:${IMAGE_WIDTH}px;background:#f4f7fb;color:#172333}
body{padding:28px;font-family:"Microsoft YaHei","Noto Sans CJK SC","PingFang SC",sans-serif}
article{background:#fff;border:1px solid #dbe4ee;border-radius:18px;padding:40px 46px;overflow-wrap:anywhere;font-size:22px;line-height:1.55}
article>:first-child{margin-top:0}article>:last-child{margin-bottom:0}
h1,h2,h3,h4,h5,h6{color:#10243d;line-height:1.3;margin:1.1em 0 .45em}h1{font-size:37px}h2{font-size:31px}h3{font-size:27px}h4,h5,h6{font-size:23px}
p,ul,ol,blockquote,pre,table{margin:.65em 0 1em}ul,ol{padding-left:1.6em}li{margin:.25em 0}
blockquote{border-left:5px solid #4b91c8;background:#f0f7fc;padding:12px 20px;color:#36536d}
code,pre{font-family:Consolas,"Noto Sans Mono CJK SC",monospace;font-size:18px}code{background:#eef3f8;border-radius:5px;padding:2px 5px}
pre{background:#172333;color:#f0f5fc;border-radius:10px;padding:18px 20px;white-space:pre-wrap;overflow-wrap:anywhere}pre code{background:none;padding:0;color:inherit}
table{border-collapse:collapse;width:100%;font-size:19px}th,td{border:1px solid #d6e0ea;padding:9px 12px;text-align:left;vertical-align:top}th{background:#edf4fa}
hr{border:0;border-top:1px solid #d9e4ed;margin:1.3em 0}.link{color:#196ca7;text-decoration:underline}.image-placeholder{display:inline-block;background:#f0f4f8;border:1px dashed #a7b9c8;border-radius:7px;padding:3px 8px;color:#526779}
</style></head><body><article>${content}</article></body></html>`;
}

function browserCandidates(): string[] {
  const configured = process.env.RABIROUTE_MARKDOWN_BROWSER_PATH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) {
      throw new Error("RABIROUTE_MARKDOWN_BROWSER_PATH must name an existing absolute browser executable.");
    }
    return [configured];
  }
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
    return roots.flatMap(root => [
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "Google", "Chrome", "Application", "chrome.exe")
    ]).filter(candidate => fs.existsSync(candidate));
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ].filter(candidate => fs.existsSync(candidate));
  }
  return ["chromium", "chromium-browser", "google-chrome", "microsoft-edge"];
}

async function launchBrowser(profileDir: string): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  const candidates = browserCandidates();
  if (candidates.length === 0) throw new Error("Markdown image rendering requires an installed Chromium, Chrome, or Edge browser.");
  let lastError: Error | undefined;
  for (const browser of candidates) {
    const child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
      "--disable-javascript", "--no-first-run", "--no-default-browser-check", "--disable-sync",
      "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank"
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdin.end();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let stderr = "";
        const timeout = setTimeout(() => reject(new Error("Markdown browser startup timed out.")), BROWSER_TIMEOUT_MS);
        const finish = (error?: Error, value?: number) => {
          clearTimeout(timeout);
          child.stderr.off("data", onData);
          child.off("error", onError);
          child.off("exit", onExit);
          if (error) reject(error); else resolve(value!);
        };
        const onData = (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-8192);
          const match = stderr.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//);
          if (match) finish(undefined, Number(match[1]));
        };
        const onError = (error: Error) => finish(error);
        const onExit = () => finish(new Error("Markdown browser exited before opening DevTools."));
        child.stderr.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
      });
      return { process: child, port };
    } catch (error) {
      child.kill();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (process.env.RABIROUTE_MARKDOWN_BROWSER_PATH) break;
    }
  }
  throw new Error(`Markdown browser could not start: ${lastError?.message || "unknown error"}`);
}

async function pageWebSocketUrl(port: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* Browser target may not be registered yet. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Markdown browser did not expose a page target.");
}

async function captureHtml(port: number, html: string): Promise<Buffer> {
  const socket = new WebSocket(await pageWebSocketUrl(port), { handshakeTimeout: 5000 });
  return captureHtmlOnSocket(socket, html);
}

async function captureHtmlOnSocket(socket: WebSocket, html: string, timeoutMs = BROWSER_TIMEOUT_MS): Promise<Buffer> {
  type Waiter = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
  let sequence = 0;
  let connectionError: Error | undefined;
  const pending = new Map<number, Waiter>();
  const events = new Map<string, Waiter>();
  const waiting = new Set<Waiter>();
  const createWaiter = (method: string, remove: () => void) => {
    let waiter!: Waiter;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => waiter.reject(new Error(`Markdown browser ${method} timed out.`)), timeoutMs);
      const finish = (error?: Error, value: Record<string, unknown> = {}) => {
        if (!waiting.delete(waiter)) return;
        clearTimeout(timer);
        remove();
        if (error) reject(error); else resolve(value);
      };
      waiter = { resolve: value => finish(undefined, value), reject: error => finish(error) };
      waiting.add(waiter);
    });
    // Registration may precede the await (notably Page.navigate); observe immediately.
    // Keep the original promise rejecting so the operation still fails closed.
    void promise.catch(() => {});
    return { waiter, promise };
  };
  const failAll = (error: Error) => {
    connectionError ??= error;
    for (const waiter of waiting) waiter.reject(connectionError);
  };
  const onError = (error: Error) => failAll(error);
  const onClose = () => failAll(new Error("Markdown browser connection closed."));
  const onMessage = (raw: WebSocket.RawData) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    if (!message || typeof message !== "object") return;
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(new Error(`Markdown browser command failed: ${String((message.error as Record<string, unknown>).message || "unknown")}`));
      else waiter.resolve((message.result || {}) as Record<string, unknown>);
    } else if (typeof message.method === "string") {
      events.get(message.method)?.resolve({});
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++sequence;
    const { waiter, promise } = createWaiter(method, () => pending.delete(id));
    pending.set(id, waiter);
    if (connectionError) waiter.reject(connectionError);
    else {
      try {
        socket.send(JSON.stringify({ id, method, params }), error => { if (error) failAll(error); });
      } catch (error) {
        failAll(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  };
  const waitFor = (method: string) => {
    const { waiter, promise } = createWaiter(method, () => events.delete(method));
    events.set(method, waiter);
    if (connectionError) waiter.reject(connectionError);
    return promise;
  };
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.on("message", onMessage);
  let onOpen: (() => void) | undefined;
  try {
    const opened = createWaiter("connection", () => { if (onOpen) socket.off("open", onOpen); });
    onOpen = () => opened.waiter.resolve({});
    socket.once("open", onOpen);
    if (socket.readyState === WebSocket.OPEN) onOpen();
    else if (socket.readyState !== WebSocket.CONNECTING) onClose();
    await opened.promise;
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: IMAGE_WIDTH, height: 100, deviceScaleFactor: 1, mobile: false });
    const loaded = waitFor("Page.loadEventFired");
    await Promise.all([
      loaded,
      send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` })
    ]);
    const metrics = await send("Page.getLayoutMetrics");
    const size = (metrics.cssContentSize || metrics.contentSize || {}) as Record<string, unknown>;
    const height = Math.ceil(Number(size.height));
    if (!Number.isFinite(height) || height < 1 || height > MAX_IMAGE_HEIGHT) {
      throw new Error(`Markdown image height must be at most ${MAX_IMAGE_HEIGHT}px; split the document into smaller sends.`);
    }
    await send("Emulation.setDeviceMetricsOverride", { width: IMAGE_WIDTH, height, deviceScaleFactor: 1, mobile: false });
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
    const png = Buffer.from(String(screenshot.data || ""), "base64");
    if (png.length < 8 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Markdown renderer returned an invalid or oversized PNG.");
    }
    return png;
  } finally {
    failAll(new Error("Markdown browser connection closed."));
    socket.off("message", onMessage);
    // Keep error handling until close, including errors caused by aborting a handshake.
    const detach = () => { socket.off("error", onError); socket.off("close", onClose); };
    if (socket.readyState === WebSocket.CLOSED) detach();
    else {
      socket.once("close", detach);
      socket.terminate();
    }
  }
}

/** @internal Socket-level seam for deterministic CDP lifecycle tests. */
export const markdownImageInternals = { captureHtmlOnSocket };

export async function renderMarkdownToPng(markdown: string): Promise<Buffer> {
  if (!markdown.trim() || Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new Error(`Markdown source must contain text and be at most ${MAX_MARKDOWN_BYTES} UTF-8 bytes.`);
  }
  const tempRoot = path.resolve(os.tmpdir());
  const profileDir = fs.mkdtempSync(path.join(tempRoot, "rabiroute-markdown-browser-"));
  let browser: ChildProcessWithoutNullStreams | undefined;
  try {
    const launched = await launchBrowser(profileDir);
    browser = launched.process;
    return await captureHtml(launched.port, markdownImageHtml(markdown));
  } finally {
    browser?.kill();
    if (path.dirname(path.resolve(profileDir)) === tempRoot && path.basename(profileDir).startsWith("rabiroute-markdown-browser-")) {
      await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

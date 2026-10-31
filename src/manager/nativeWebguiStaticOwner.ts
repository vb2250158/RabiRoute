import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import type { ApiHttpProxyInput } from "./apiOperationContract.js";
import { WEB_PATCH_HASH, WEB_PATCH_PREFIX, webPatchPath, type WebPatchManifest } from "./webPatchCatalog.js";
import type { WebPatchService } from "./webPatchService.js";

const webTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2"
};
const patchTypes = { ...webTypes, ".md": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const missingBuild = "RabiRoute WebGUI build is missing. Run `npm run webgui:build` or `npm run build`.";
const immutable = "public, max-age=31536000, immutable";
type OpenFile = { handle: FileHandle; root: string; realRoot: string; filename: string; rootStat: Stats; stat: Stats };

function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function sameRoot(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

/** Fixed-width substitutions keep only a UTF-8 decoder and a 64-character boundary window. */
function documentRewrite(revision: string): Transform {
  const decoder = new StringDecoder("utf8"); let pending = ""; let html = false;
  const root = /<html\b/i;
  const assets = /((?:src|href)=["'])((?:\.\/|\/)?assets\/)(?=[^"'])/g;
  const flush = (final: boolean): string => {
    let end = final ? pending.length : Math.max(0, pending.length - 64);
    if (!final) for (const expression of [root, assets]) {
      for (const match of pending.matchAll(new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : expression.flags + "g"))) {
        if (match.index! < end && match.index! + match[0].length >= end) end = match.index!;
      }
    }
    // StringDecoder preserves UTF-8 characters; the retained UTF-16 window must
    // also avoid splitting a surrogate pair before Transform encodes its output.
    if (!final && end > 0 && /[\uD800-\uDBFF]/.test(pending[end - 1]!) && /[\uDC00-\uDFFF]/.test(pending[end]!)) end--;
    let output = pending.slice(0, end); pending = pending.slice(end);
    if (!html) output = output.replace(root, match => { html = true; return `${match} data-rabi-web-release="${revision}"`; });
    return output.replace(assets, (_match, prefix: string) => `${prefix}${WEB_PATCH_PREFIX}${revision}/web/assets/`);
  };
  return new Transform({ transform(chunk, _encoding, done) { pending += decoder.write(chunk); done(null, flush(false)); },
    flush(done) { pending += decoder.end(); done(null, flush(true)); } });
}

/** Filesystem owner for the existing package/dist and immutable Web release resources. */
export class NativeWebguiStaticOwner {
  private activeFiles = 0;
  constructor(private readonly options: {
    packageRoot: string; webuiDistPath: string;
    patches: Pick<WebPatchService, "candidates" | "status" | "staticManifest">;
    isControlPath(pathname: string): boolean;
  }) {}

  activeFileCount(): number { return this.activeFiles; }

  private async open(root: string, relative: string, input: ApiHttpProxyInput): Promise<OpenFile | undefined> {
    input.assertCurrent();
    const filename = path.resolve(root, relative);
    if (!within(root, filename)) return undefined;
    let handle: FileHandle | undefined;
    try {
      const realRoot = await fs.realpath(root); input.assertCurrent();
      const rootStat = await fs.stat(realRoot); input.assertCurrent();
      const realFile = await fs.realpath(filename); input.assertCurrent();
      if (!within(realRoot, realFile)) return undefined;
      handle = await fs.open(realFile, "r"); input.assertCurrent();
      const stat = await handle.stat(); input.assertCurrent();
      if (!stat.isFile()) { await handle.close(); return undefined; }
      const file = { handle, root, realRoot, filename, rootStat, stat };
      await this.assertFile(file, input);
      this.activeFiles++;
      return file;
    } catch (error) {
      await handle?.close();
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
  }

  private async assertFile(file: OpenFile, input: ApiHttpProxyInput): Promise<void> {
    input.assertCurrent();
    const realRoot = await fs.realpath(file.root); input.assertCurrent();
    const rootStat = await fs.stat(realRoot); input.assertCurrent();
    if (realRoot !== file.realRoot || !sameRoot(rootStat, file.rootStat)) throw new Error("Static resource root changed.");
    const realFile = await fs.realpath(file.filename); input.assertCurrent();
    if (!within(file.realRoot, realFile)) throw new Error("Static resource escaped its root.");
    const stat = await fs.stat(realFile); input.assertCurrent();
    if (!sameFile(stat, file.stat)) throw new Error("Static resource changed while reading.");
  }

  private async close(file: OpenFile): Promise<void> {
    try { await file.handle.close(); } finally { this.activeFiles--; }
  }

  private async verify(file: OpenFile, expected: { size: number; sha256: string }, input: ApiHttpProxyInput): Promise<void> {
    if (file.stat.size !== expected.size) throw new Error("Web patch asset integrity failed.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < expected.size) {
      input.assertCurrent();
      const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, expected.size - position), position); input.assertCurrent();
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    await this.assertFile(file, input);
    if (hash.digest("hex") !== expected.sha256) throw new Error("Web patch asset integrity failed.");
  }

  private async sendFile(file: OpenFile, input: ApiHttpProxyInput, headers: Record<string, string>, revision?: string): Promise<void> {
    try {
      await this.assertFile(file, input);
      input.prepareResponse(200, headers); input.assertCurrent(); input.response.writeHead(200, headers);
      if (input.request.method === "HEAD") { input.response.end(); return; }
      const owner = this;
      const source = Readable.from((async function* () {
        let position = 0;
        while (true) {
          await owner.assertFile(file, input);
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position); input.assertCurrent();
          if (!bytesRead) break;
          await owner.assertFile(file, input);
          position += bytesRead; yield buffer.subarray(0, bytesRead);
        }
      })(), { highWaterMark: 1 });
      if (revision) await pipeline(source, documentRewrite(revision), input.response, { signal: input.signal });
      else await pipeline(source, input.response, { signal: input.signal });
    } finally { await this.close(file); }
  }

  private send(input: ApiHttpProxyInput, status: number, body: string, headers: Record<string, string>): void {
    input.prepareResponse(status, headers); input.assertCurrent(); input.response.writeHead(status, headers);
    input.response.end(input.request.method === "HEAD" ? undefined : body);
  }
  private json(input: ApiHttpProxyInput, status: number, body: unknown): void {
    this.send(input, status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  }

  private async manifest(revision: string, input: ApiHttpProxyInput): Promise<Readonly<WebPatchManifest>> {
    // Publication identity, compatibility and manifest caching remain with WebPatchService.
    const manifest = await this.options.patches.staticManifest(revision); input.assertCurrent();
    const backend = this.options.patches.status().backend;
    if (backend !== undefined && backend !== manifest.backend) throw new Error("Web patch backend changed; a coordinated full release is required.");
    return manifest;
  }

  private async patchFile(revision: string, filename: string, input: ApiHttpProxyInput): Promise<OpenFile> {
    webPatchPath(filename);
    const root = path.join(this.options.patches.candidates, revision);
    const realRoot = await fs.realpath(root); input.assertCurrent();
    const rootStat = await fs.stat(realRoot); input.assertCurrent();
    const manifest = await this.manifest(revision, input);
    const record = manifest.files.find(file => file.path === filename);
    if (!record) throw new Error("Web patch asset was not found.");
    const file = await this.open(root, filename, input);
    if (!file) throw new Error("Web patch asset was not found.");
    try {
      if (file.realRoot !== realRoot || !sameRoot(file.rootStat, rootStat)) throw new Error("Static resource root changed.");
      await this.verify(file, record, input); return file;
    }
    catch (error) { await this.close(file); throw error; }
  }

  async patch(input: ApiHttpProxyInput): Promise<void> {
    if (!["GET", "HEAD"].includes(input.request.method ?? "")) { this.json(input, 405, { code: -1 }); return; }
    const match = input.url.pathname.match(/^\/_rabiroute\/web\/([a-f0-9]{64})\/(.+)$/);
    if (!match) { this.json(input, 404, { code: -1 }); return; }
    let filename: string;
    try { filename = decodeURIComponent(match[2]!); } catch { this.json(input, 400, { code: -1 }); return; }
    try {
      const file = await this.patchFile(match[1]!, filename, input);
      await this.sendFile(file, input, { "content-type": patchTypes[path.extname(filename) as keyof typeof patchTypes] ?? "application/octet-stream",
        "cache-control": immutable, "x-content-type-options": "nosniff", "x-rabiroute-web-revision": match[1]! });
    } catch (error) {
      input.assertCurrent(); if (input.response.headersSent) throw error;
      this.json(input, 404, { code: -1, message: "Web patch asset is unavailable or failed integrity verification." });
    }
  }

  async fallback(input: ApiHttpProxyInput): Promise<void> {
    const pathname = input.url.pathname;
    // The controller's native API/private boundary must win before the SPA selector.
    if (this.options.isControlPath(pathname) || pathname.startsWith("/_rabiroute/")) {
      this.json(input, 404, { code: -1, message: "Manager API route not found." }); return;
    }
    const asset = input.request.method === "GET" && pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/);
    if (asset) {
      const file = await this.open(path.join(this.options.packageRoot, "assets"), asset[1]!, input);
      if (file) {
        const extension = path.extname(asset[1]!).toLowerCase();
        await this.sendFile(file, input, { "content-type": extension === ".png" ? "image/png" : extension === ".svg" ? "image/svg+xml; charset=utf-8" : "application/octet-stream" }); return;
      }
    }
    if (["GET", "HEAD"].includes(input.request.method ?? "") && (pathname === "/index.html" || !path.extname(pathname))) {
      const revision = this.options.patches.status().active;
      if (revision !== undefined) {
        try {
          if (!WEB_PATCH_HASH.test(revision)) throw new Error("Invalid Web release revision.");
          const file = await this.patchFile(revision, "web/index.html", input);
          await this.sendFile(file, input, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-rabiroute-web-revision": revision }, revision); return;
        } catch (error) {
          input.assertCurrent(); if (input.response.headersSent) throw error;
          this.json(input, 503, { code: -1, message: "Web document integrity is unavailable." }); return;
        }
      }
    }
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); }
    catch { this.json(input, 500, { error: "URI malformed" }); return; }
    const relative = path.normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
    const root = this.options.webuiDistPath;
    if (decoded.includes("\0") || !within(root, path.resolve(root, relative))) {
      this.send(input, 503, missingBuild, { "content-type": "text/plain; charset=utf-8" }); return;
    }
    const index = await this.open(root, "index.html", input);
    if (index) {
      await this.close(index);
      const file = await this.open(root, relative, input) ?? (!path.extname(relative) ? await this.open(root, "index.html", input) : undefined);
      if (file) {
        if (file.realRoot !== index.realRoot || !sameRoot(file.rootStat, index.rootStat)) {
          await this.close(file); throw new Error("Static resource root changed.");
        }
        const indexFile = path.resolve(file.filename) === path.resolve(root, "index.html");
        const cache = indexFile ? "no-store" : /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path.basename(file.filename)) ? immutable : "no-cache";
        await this.sendFile(file, input, { "content-type": webTypes[path.extname(file.filename).toLowerCase()] ?? "application/octet-stream", "cache-control": cache }); return;
      }
    }
    this.send(input, 503, missingBuild, { "content-type": "text/plain; charset=utf-8" });
  }
}

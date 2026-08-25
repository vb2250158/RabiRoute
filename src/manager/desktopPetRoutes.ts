import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { importDesktopPetPack } from "./desktopPetPackImport.js";
import {
  DEFAULT_DESKTOP_PET_BINDING,
  normalizeDesktopPetBinding,
  type DesktopPetBinding,
  type DesktopSettings
} from "../shared/desktopSettingsContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";

const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const IMAGE_EXTENSIONS = new Set([".gif", ".png"]);
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type DesktopPetStateAsset = {
  type: "gif" | "png-sequence";
  assets: string[];
  fps: number;
  loop: boolean;
  next?: string;
};

export type DesktopPetPackPresentation = {
  id: string;
  name: string;
  personaId: string;
  canvas: {
    width: number;
    height: number;
    anchorX: number;
    anchorY: number;
  };
  scale: number;
  states: Record<string, DesktopPetStateAsset>;
};

export type DesktopPetPackCatalog = {
  personaId: string;
  packs: DesktopPetPackPresentation[];
  diagnostics: Array<{ packId: string; message: string }>;
};

export type DesktopPetSettingsAccess = {
  read(): DesktopSettings;
  write(value: unknown): DesktopSettings;
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function safePackId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return PACK_ID_PATTERN.test(id) ? id : "";
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveInside(root: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) return undefined;
  const candidate = path.resolve(root, relativePath);
  return inside(path.resolve(root), candidate) ? candidate : undefined;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function patternMatcher(pattern: string): (fileName: string) => boolean {
  const normalized = path.basename(pattern || "*.png");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const expression = new RegExp(`^${escaped}$`, "i");
  return (fileName: string) => expression.test(fileName);
}

function assetUrl(roleId: string, packId: string, packRelativePath: string): string {
  const encodedPath = packRelativePath.split(/[\\/]+/).map(segment => encodeURIComponent(segment)).join("/");
  return `/api/roles/${encodeURIComponent(roleId)}/desktop-pet/packs/${encodeURIComponent(packId)}/assets/${encodedPath}`;
}

function statePresentation(
  roleId: string,
  packId: string,
  packDir: string,
  stateName: string,
  rawState: unknown,
  defaults: JsonObject
): DesktopPetStateAsset | undefined {
  const state = objectValue(rawState);
  const type = state.type === "gif" ? "gif" : state.type === "png-sequence" ? "png-sequence" : undefined;
  const source = typeof state.source === "string" ? state.source.trim() : "";
  if (!type || !source) return undefined;
  const sourcePath = resolveInside(packDir, source);
  if (!sourcePath) return undefined;
  if (!fs.existsSync(sourcePath)) return undefined;
  const realPackDir = fs.realpathSync(packDir);
  const realSourcePath = fs.realpathSync(sourcePath);
  if (!inside(realPackDir, realSourcePath)) return undefined;

  let packRelativeAssets: string[] = [];
  if (type === "gif") {
    if (path.extname(sourcePath).toLowerCase() !== ".gif" || !fs.statSync(sourcePath).isFile()) {
      return undefined;
    }
    packRelativeAssets = [path.relative(packDir, sourcePath)];
  } else {
    if (!fs.statSync(sourcePath).isDirectory()) return undefined;
    const matches = patternMatcher(typeof state.pattern === "string" ? state.pattern : `${stateName}_*.png`);
    packRelativeAssets = fs.readdirSync(sourcePath, { withFileTypes: true })
      .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === ".png" && matches(entry.name))
      .map(entry => path.relative(packDir, path.join(sourcePath, entry.name)))
      .sort(naturalCompare);
    if (packRelativeAssets.length === 0 || packRelativeAssets.length > 600) return undefined;
  }

  const next = typeof state.next === "string" && state.next.trim() ? state.next.trim() : undefined;
  return {
    type,
    assets: packRelativeAssets.map(relativePath => assetUrl(roleId, packId, relativePath)),
    fps: finiteNumber(state.fps ?? defaults.fps, 12, 1, 24),
    loop: typeof state.loop === "boolean" ? state.loop : defaults.loop !== false,
    ...(next ? { next } : {})
  };
}

function readPack(roleId: string, packDir: string): DesktopPetPackPresentation {
  const manifestPath = path.join(packDir, "pet-pack.json");
  const manifest = objectValue(JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")));
  const packId = safePackId(manifest.id);
  const directoryPackId = path.basename(packDir);
  if (!packId || packId !== directoryPackId) throw new Error("Manifest id must match its pack directory.");
  if (manifest.personaId !== roleId) throw new Error("Manifest personaId does not match its role directory.");

  const canvas = objectValue(manifest.canvas);
  const defaults = objectValue(manifest.defaults);
  const rawStates = objectValue(manifest.states);
  const states: Record<string, DesktopPetStateAsset> = {};
  for (const [stateName, rawState] of Object.entries(rawStates)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/i.test(stateName)) continue;
    const presentation = statePresentation(roleId, packId, packDir, stateName, rawState, defaults);
    if (presentation) states[stateName] = presentation;
  }
  if (!states.idle) throw new Error("A runnable desktop pet pack must contain a valid idle state.");

  return {
    id: packId,
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim().slice(0, 120) : packId,
    personaId: roleId,
    canvas: {
      width: finiteNumber(canvas.width, 512, 1, 2048),
      height: finiteNumber(canvas.height, 512, 1, 2048),
      anchorX: finiteNumber(canvas.anchorX, 0.5, 0, 1),
      anchorY: finiteNumber(canvas.anchorY, 0.96, 0, 1)
    },
    scale: finiteNumber(defaults.scale, 0.5, 0.1, 2),
    states
  };
}

export function listDesktopPetPacks(roleIdInput: unknown, roleDir: string): DesktopPetPackCatalog {
  const roleId = sanitizeRoleId(roleIdInput);
  if (!roleId) throw new Error("Invalid role id.");
  const packsRoot = path.join(roleDir, "desktop-pet", "packs");
  const packs: DesktopPetPackPresentation[] = [];
  const diagnostics: DesktopPetPackCatalog["diagnostics"] = [];
  if (!fs.existsSync(packsRoot)) return { personaId: roleId, packs, diagnostics };

  for (const entry of fs.readdirSync(packsRoot, { withFileTypes: true }).sort((a, b) => naturalCompare(a.name, b.name))) {
    if (!entry.isDirectory() || !PACK_ID_PATTERN.test(entry.name)) continue;
    const packDir = path.join(packsRoot, entry.name);
    if (!fs.existsSync(path.join(packDir, "pet-pack.json"))) continue;
    try {
      packs.push(readPack(roleId, packDir));
    } catch (error) {
      diagnostics.push({ packId: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { personaId: roleId, packs, diagnostics };
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("Desktop pet settings payload is too large.");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function readBinaryBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("Desktop pet import is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) throw new Error("Desktop pet import is empty.");
  return Buffer.concat(chunks);
}

function readBinding(settings: DesktopPetSettingsAccess, roleId: string): DesktopPetBinding {
  return settings.read().pets[roleId] ?? { ...DEFAULT_DESKTOP_PET_BINDING };
}

function updateBinding(
  settings: DesktopPetSettingsAccess,
  roleId: string,
  body: unknown,
  roleDir: string
): DesktopPetBinding {
  const row = objectValue(body);
  if (typeof row.personaId === "string" && row.personaId !== roleId) {
    throw new Error("Desktop pet personaId must match the role path.");
  }
  const current = settings.read();
  const binding = normalizeDesktopPetBinding({ ...(current.pets[roleId] ?? DEFAULT_DESKTOP_PET_BINDING), ...row });
  if (binding.packId) {
    const catalog = listDesktopPetPacks(roleId, roleDir);
    if (!catalog.packs.some(pack => pack.id === binding.packId)) {
      throw new Error("Desktop pet pack does not belong to this persona or is not runnable.");
    }
  }
  return settings.write({ ...current, pets: { ...current.pets, [roleId]: binding } }).pets[roleId]!;
}

function serveAsset(response: http.ServerResponse, roleDir: string, packId: string, relativePath: string): void {
  if (!PACK_ID_PATTERN.test(packId)) throw new Error("Invalid desktop pet pack id.");
  const packRoot = path.resolve(roleDir, "desktop-pet", "packs", packId);
  const candidate = resolveInside(packRoot, relativePath);
  if (!candidate || !IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) throw new Error("Invalid desktop pet asset path.");
  const realPackRoot = fs.realpathSync(packRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!inside(realPackRoot, realCandidate)) throw new Error("Desktop pet asset escapes its pack directory.");
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error("Desktop pet asset is unavailable or too large.");
  response.writeHead(200, {
    "content-type": path.extname(realCandidate).toLowerCase() === ".gif" ? "image/gif" : "image/png",
    "content-length": String(stat.size),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff"
  });
  fs.createReadStream(realCandidate).pipe(response);
}

export function handleDesktopPetApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  resolveRoleDir: (roleId: string) => string,
  settings?: DesktopPetSettingsAccess
): boolean {
  const bindingMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/desktop-pet$/);
  const importMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/desktop-pet\/packs\/import$/);
  const catalogMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/desktop-pet\/packs$/);
  const assetMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/desktop-pet\/packs\/([^/]+)\/assets\/(.+)$/);
  if (!bindingMatch && !importMatch && !catalogMatch && !assetMatch) return false;
  if (bindingMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(bindingMatch[1]));
    if (!roleId || !settings) {
      jsonResponse(response, 503, { code: -1, message: "Desktop pet settings are unavailable." });
      return true;
    }
    if (request.method === "GET") {
      jsonResponse(response, 200, { code: 0, data: { personaId: roleId, binding: readBinding(settings, roleId) } });
      return true;
    }
    if (request.method === "PATCH" || request.method === "PUT") {
      void readJsonBody(request)
        .then(body => updateBinding(settings, roleId, body, resolveRoleDir(roleId)))
        .then(binding => jsonResponse(response, 200, { code: 0, data: { personaId: roleId, binding } }))
        .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  }
  if (importMatch) {
    if (request.method !== "POST") {
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    }
    const roleId = sanitizeRoleId(decodeURIComponent(importMatch[1]));
    if (!roleId) {
      jsonResponse(response, 400, { code: -1, message: "Invalid role id." });
      return true;
    }
    const roleDir = resolveRoleDir(roleId);
    void readBinaryBody(request)
      .then(payload => {
        const packId = importDesktopPetPack(
          roleId,
          roleDir,
          requestUrl.searchParams.get("fileName") || String(request.headers["x-rabi-file-name"] || "upload"),
          String(request.headers["content-type"] || "application/octet-stream"),
          payload,
          {
            packId: requestUrl.searchParams.get("packId") || undefined,
            state: requestUrl.searchParams.get("state") || undefined,
            name: requestUrl.searchParams.get("name") || undefined
          }
        );
        const catalog = listDesktopPetPacks(roleId, roleDir);
        const pack = catalog.packs.find(item => item.id === packId);
        if (!pack) {
          const target = path.join(roleDir, "desktop-pet", "packs", packId);
          if (inside(path.join(roleDir, "desktop-pet", "packs"), target)) fs.rmSync(target, { recursive: true, force: true });
          throw new Error(catalog.diagnostics.find(item => item.packId === packId)?.message || "Imported desktop pet pack is not runnable.");
        }
        return pack;
      })
      .then(pack => jsonResponse(response, 201, { code: 0, data: { personaId: roleId, pack } }))
      .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method !== "GET") {
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  }
  try {
    const match = assetMatch ?? catalogMatch;
    const roleId = sanitizeRoleId(decodeURIComponent(match![1]));
    if (!roleId) throw new Error("Invalid role id.");
    const roleDir = resolveRoleDir(roleId);
    if (assetMatch) {
      serveAsset(response, roleDir, decodeURIComponent(assetMatch[2]), decodeURIComponent(assetMatch[3]));
    } else {
      jsonResponse(response, 200, { code: 0, data: listDesktopPetPacks(roleId, roleDir) });
    }
  } catch (error) {
    jsonResponse(response, 404, { code: -1, message: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

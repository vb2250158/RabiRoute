import { errorResponsePresentation } from "../shared/errorPresentation.js";
import { readDesktopPetDialogue } from "./desktopPetDialogue.js";
import { appendDesktopPetTranscript } from "../desktopPetTranscript.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { managerReadWorkerPool } from "./managerReadWorkerPool.js";
import type { ApiOperationResult } from "./apiOperationContract.js";

import path from "node:path";
import { copyDesktopPetPackDirectoryAsync, importDesktopPetPack } from "./desktopPetPackImport.js";
import {
  DEFAULT_DESKTOP_PET_BINDING,
  normalizeDesktopPetBinding,
  type DesktopPetBinding,
  type DesktopSettings
} from "../shared/desktopSettingsContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { normalizeDesktopPetModeAnimationSets, type DesktopPetModeAnimationSet } from "../shared/desktopPetModeAnimationSets.js";

const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const IMAGE_EXTENSIONS = new Set([".gif", ".png"]);
export const DESKTOP_PET_LIMITS = Object.freeze({ assetBytes: 64 * 1024 * 1024, jsonBytes: 64 * 1024, importBytes: 128 * 1024 * 1024, motionBytes: 8192 });
const MAX_ASSET_BYTES = DESKTOP_PET_LIMITS.assetBytes;
const DEFAULT_DESKTOP_PET_CACHE_ROOT = path.join(process.cwd(), "data", "cache", "desktop-pet-roles");

type JsonObject = Record<string, unknown>;

export type DesktopPetStateAsset = {
  type: "gif" | "png-sequence";
  assets: string[];
  fps: number;
  loop: boolean;
  next?: string;
};

export type DesktopPetIdleBehavior = {
  randomMinSeconds: number;
  randomMaxSeconds: number;
  randomStates: string[];
  sleepAfterSeconds?: number;
  sleepState?: string;
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
  sourceFacing: "left" | "right";
  states: Record<string, DesktopPetStateAsset>;
  idleBehavior?: DesktopPetIdleBehavior;
  companionStates?: Record<string, string>;
  modeAnimationSets?: Record<string, DesktopPetModeAnimationSet>;
};

export type DesktopPetPackCatalog = {
  personaId: string;
  packs: DesktopPetPackPresentation[];
  diagnostics: Array<{ packId: string; message: string }>;
};

export type DesktopPetPackCatalogOptions = {
  includeSharedSource?: boolean;
  packId?: string;
};

export type DesktopPetSettingsAccess = {
  read(): DesktopSettings;
  write(value: unknown): DesktopSettings;
};

export type DesktopPetEventPublisher = (eventType: string, data: unknown) => void;

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

async function syncImportedPackToRuntimeCache(
  roleId: string,
  roleDir: string,
  packId: string,
  cacheRoot: string
): Promise<void> {
  const sourceRoot = path.resolve(roleDir, "desktop-pet", "packs");
  const sourcePack = path.resolve(sourceRoot, packId);
  const runtimePacksRoot = path.resolve(cacheRoot, roleId, "desktop-pet", "packs");
  const runtimePack = path.resolve(runtimePacksRoot, packId);
  if (!inside(sourceRoot, sourcePack) || !inside(runtimePacksRoot, runtimePack)) {
    throw new Error("Desktop pet pack path is invalid.");
  }
  if (!fs.existsSync(path.join(sourcePack, "pet-pack.json"))) {
    throw new Error("Imported desktop pet pack is missing its manifest.");
  }
  if (fs.existsSync(runtimePack)) {
    throw new Error("Desktop pet runtime cache already contains this pack id.");
  }
  fs.mkdirSync(runtimePacksRoot, { recursive: true });
  const stagingPack = path.join(runtimePacksRoot, `.staging-${randomUUID()}`);
  try {
    await copyDesktopPetPackDirectoryAsync(sourcePack, stagingPack);
    // COPYFILE_EXCL and the immutable id check prevent an existing pack overwrite.
    if (fs.existsSync(runtimePack)) throw new Error("Desktop pet runtime cache already contains this pack id.");
    await fs.promises.rename(stagingPack, runtimePack);
  } catch (error) {
    await fs.promises.rm(stagingPack, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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
  return `/api/desktop-pet/roles/${encodeURIComponent(roleId)}/packs/${encodeURIComponent(packId)}/assets/${encodedPath}`;
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

function idleBehaviorPresentation(
  rawBehavior: unknown,
  states: Record<string, DesktopPetStateAsset>
): DesktopPetIdleBehavior | undefined {
  const behavior = objectValue(rawBehavior);
  const randomInterval = objectValue(behavior.randomIntervalSeconds);
  const randomStates = Array.isArray(behavior.randomStates)
    ? [...new Set(behavior.randomStates
      .filter((name): name is string => typeof name === "string")
      .map(name => name.trim())
      .filter(name => name !== "idle"
        && states[name]?.loop === false
        && states[name]?.next === "idle"))].slice(0, 12)
    : [];
  const randomMinSeconds = finiteNumber(randomInterval.min, 90, 5, 3600);
  const randomMaxSeconds = finiteNumber(randomInterval.max, 240, randomMinSeconds, 3600);
  const requestedSleepState = typeof behavior.sleepState === "string" ? behavior.sleepState.trim() : "";
  const sleepState = requestedSleepState
    && requestedSleepState !== "idle"
    && states[requestedSleepState]?.loop === true
    ? requestedSleepState
    : undefined;
  const sleepAfterSeconds = sleepState
    ? finiteNumber(behavior.sleepAfterSeconds, 900, 60, 86400)
    : undefined;
  if (!randomStates.length && !sleepState) return undefined;
  return {
    randomMinSeconds,
    randomMaxSeconds,
    randomStates,
    ...(sleepState ? { sleepAfterSeconds, sleepState } : {})
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
  const idleBehavior = idleBehaviorPresentation(manifest.idleBehavior, states);
  const companionStates = Object.fromEntries(Object.entries(objectValue(manifest.companionStates))
    .filter(([kind, state]) => /^[a-z][a-z0-9-]{0,39}$/.test(kind) && typeof state === "string"
      && states[state]?.loop === true).slice(0, 16)) as Record<string, string>;
  const modeAnimationSets = normalizeDesktopPetModeAnimationSets(manifest.modeAnimationSets, states);

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
    sourceFacing: manifest.sourceFacing === "left" ? "left" : "right",
    states,
    ...(idleBehavior ? { idleBehavior } : {}),
    ...(Object.keys(companionStates).length ? { companionStates } : {}),
    ...(Object.keys(modeAnimationSets).length ? { modeAnimationSets } : {})
  };
}

export function listDesktopPetPacks(
  roleIdInput: unknown,
  roleDir: string,
  cacheRoot = DEFAULT_DESKTOP_PET_CACHE_ROOT,
  options: DesktopPetPackCatalogOptions = {}
): DesktopPetPackCatalog {
  const roleId = sanitizeRoleId(roleIdInput);
  if (!roleId) throw new Error("Invalid role id.");
  const packs: DesktopPetPackPresentation[] = [];
  const diagnostics: DesktopPetPackCatalog["diagnostics"] = [];
  const seenPackIds = new Set<string>();
  const locations = [{ label: "cache", roleDir: path.join(cacheRoot, roleId) }];
  if (options.includeSharedSource !== false) locations.push({ label: "source", roleDir });
  for (const location of locations) {
    if (options.packId && seenPackIds.has(options.packId)) break;
    const packsRoot = path.join(location.roleDir, "desktop-pet", "packs");
    if (!fs.existsSync(packsRoot)) continue;
    try {
      const entries = fs.readdirSync(packsRoot, { withFileTypes: true }).sort((a, b) => naturalCompare(a.name, b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || !PACK_ID_PATTERN.test(entry.name) || seenPackIds.has(entry.name)
            || (options.packId && entry.name !== options.packId)) continue;
        const packDir = path.join(packsRoot, entry.name);
        if (!fs.existsSync(path.join(packDir, "pet-pack.json"))) continue;
        try {
          packs.push(readPack(roleId, packDir));
          seenPackIds.add(entry.name);
        } catch (error) {
          diagnostics.push({ packId: entry.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      diagnostics.push({ packId: location.label, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { personaId: roleId, packs, diagnostics };
}

function readBinding(settings: DesktopPetSettingsAccess, roleId: string): DesktopPetBinding {
  return settings.read().pets[roleId] ?? { ...DEFAULT_DESKTOP_PET_BINDING };
}

async function updateBinding(
  settings: DesktopPetSettingsAccess,
  roleId: string,
  body: unknown,
  roleDir: string,
  cacheRoot: string,
  queryCatalog: DesktopPetCatalogReader
): Promise<DesktopPetBinding> {
  const row = objectValue(body);
  if (typeof row.personaId === "string" && row.personaId !== roleId) {
    throw new Error("Desktop pet personaId must match the role path.");
  }
  const current = settings.read();
  const binding = normalizeDesktopPetBinding({ ...(current.pets[roleId] ?? DEFAULT_DESKTOP_PET_BINDING), ...row });
  if (binding.packId && binding.packId !== current.pets[roleId]?.packId) {
    const catalog = await queryCatalog(roleId, roleDir, cacheRoot, { packId: binding.packId }, 120_000);
    if (!catalog.packs.some(pack => pack.id === binding.packId)) {
      throw new Error("Desktop pet pack does not belong to this persona or is not runnable.");
    }
  }
  const latest = settings.read();
  const updated = normalizeDesktopPetBinding({ ...(latest.pets[roleId] ?? DEFAULT_DESKTOP_PET_BINDING), ...row });
  return settings.write({ ...latest, pets: { ...latest.pets, [roleId]: updated } }).pets[roleId]!;
}

async function readAsset(
  roleDir: string,
  roleId: string,
  packId: string,
  relativePath: string,
  cacheRoot: string
): Promise<ApiOperationResult> {
  if (!PACK_ID_PATTERN.test(packId)) throw new Error("Invalid desktop pet pack id.");
  const cachedPackRoot = path.resolve(cacheRoot, roleId, "desktop-pet", "packs", packId);
  const sourcePackRoot = path.resolve(roleDir, "desktop-pet", "packs", packId);
  let packRoot = cachedPackRoot;
  try { await fs.promises.access(path.join(cachedPackRoot, "pet-pack.json")); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(assetReadErrorCode(error) ?? "")) throw error;
    packRoot = sourcePackRoot;
  }
  const candidate = resolveInside(packRoot, relativePath);
  if (!candidate || !IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) throw new Error("Invalid desktop pet asset path.");
  const realPackRoot = await fs.promises.realpath(packRoot);
  const realCandidate = await fs.promises.realpath(candidate);
  if (!inside(realPackRoot, realCandidate)) throw new Error("Desktop pet asset escapes its pack directory.");
  const stat = await fs.promises.stat(realCandidate);
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error("Desktop pet asset is unavailable or too large.");
  const payload = await fs.promises.readFile(realCandidate);
  if (payload.length > MAX_ASSET_BYTES) throw new Error("Desktop pet asset is too large.");
  return { status: 200, body: payload, headers: {
    "content-type": path.extname(realCandidate).toLowerCase() === ".gif" ? "image/gif" : "image/png",
    "content-length": String(payload.length), "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff"
  } };
}

function assetReadErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isTransientAssetReadError(error: unknown): boolean {
  return ["EMFILE", "ENFILE", "EBUSY"].includes(assetReadErrorCode(error) ?? "");
}


export type DesktopPetCatalogReader = (roleId: string, roleDir: string, cacheRoot: string, options: DesktopPetPackCatalogOptions, timeoutMs: number) => Promise<DesktopPetPackCatalog>;
export type DesktopPetOwnerScope = Readonly<{ roleId: string; roleDir: string }>;
export type DesktopPetOwnerContext = {
  resolveRoleDir: (roleId: string) => string;
  settings?: DesktopPetSettingsAccess;
  cacheRoot?: string;
  publishEvent?: DesktopPetEventPublisher;
  /** Controlled owner seam; completion callback must acknowledge the actual worker/task release, even after timeout. */
  catalogQuery?: (roleId: string, roleDir: string, cacheRoot: string, options: DesktopPetPackCatalogOptions, timeoutMs: number, onReleased: () => void) => Promise<DesktopPetPackCatalog>;
};

/** Owns real background worker leases; HTTP completion alone cannot retire an active catalog task. */
export class DesktopPetOwner {
  private accepting = true;
  private readonly workerReleases = new Set<Promise<void>>();
  readonly cacheRoot: string;
  constructor(readonly context: DesktopPetOwnerContext) { this.cacheRoot = context.cacheRoot ?? DEFAULT_DESKTOP_PET_CACHE_ROOT; }
  capture(rawRoleId: string): DesktopPetOwnerScope {
    if (!this.accepting) throw new Error("Desktop pet owner is stopping.");
    const roleId = sanitizeRoleId(rawRoleId); if (!roleId) throw new Error("Invalid role id.");
    return Object.freeze({ roleId, roleDir: this.context.resolveRoleDir(roleId) });
  }
  async stop(): Promise<void> { this.accepting = false; while (this.workerReleases.size) await Promise.all([...this.workerReleases]); }
  activeWorkerCount(): number { return this.workerReleases.size; }
  readonly queryCatalog: DesktopPetCatalogReader = (roleId, roleDir, cacheRoot, options, timeoutMs) => {
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
    this.workerReleases.add(released); void released.then(() => this.workerReleases.delete(released));
    try {
      return this.context.catalogQuery ? this.context.catalogQuery(roleId, roleDir, cacheRoot, options, timeoutMs, release)
        : managerReadWorkerPool.run<DesktopPetPackCatalog>({ type: "desktop_pet_catalog", roleId, roleDir, cacheRoot, options }, { timeoutMs, onWorkerReleased: release });
    } catch (error) { release(); throw error; }
  };
  bindingRead(roleId: string): ApiOperationResult {
    if (!this.context.settings) return { status: 503, body: { code: -1, message: "Desktop pet settings are unavailable." } };
    return { status: 200, body: { code: 0, data: { personaId: roleId, binding: readBinding(this.context.settings, roleId) } } };
  }
  async bindingWrite(scope: DesktopPetOwnerScope, body: unknown): Promise<ApiOperationResult> {
    if (!this.context.settings) return this.bindingRead(scope.roleId);
    const binding = await updateBinding(this.context.settings, scope.roleId, body, scope.roleDir, this.cacheRoot, this.queryCatalog);
    this.context.publishEvent?.("desktop_settings_changed", { scope: "desktop-pet", personaId: scope.roleId });
    return { status: 200, body: { code: 0, data: { personaId: scope.roleId, binding } } };
  }
  async dialogue(scope: DesktopPetOwnerScope): Promise<ApiOperationResult> {
    return { status: 200, body: { code: 0, data: { personaId: scope.roleId, dialogue: await readDesktopPetDialogue(scope.roleId, scope.roleDir) } } };
  }
  transcript(scope: DesktopPetOwnerScope, value: unknown): ApiOperationResult {
    const body = objectValue(value);
    if (body.personaId !== scope.roleId || body.voice !== scope.roleId || body.kind !== "tts") throw new Error("Desktop pet speech must belong to the requested persona.");
    const appended = appendDesktopPetTranscript(scope.roleId, scope.roleDir, { kind: "tts", id: body.id, text: body.text, time: body.time, source: "host-playback" });
    return { status: 200, body: { code: 0, data: { personaId: scope.roleId, appended } } };
  }
  async catalog(scope: DesktopPetOwnerScope, includeSharedSource: boolean): Promise<ApiOperationResult> {
    const catalog = await this.queryCatalog(scope.roleId, scope.roleDir, this.cacheRoot, { includeSharedSource }, includeSharedSource ? 120_000 : 30_000);
    return { status: 200, body: { code: 0, data: catalog } };
  }
  async asset(scope: DesktopPetOwnerScope, packId: string, relativePath: string): Promise<ApiOperationResult> {
    return readAsset(scope.roleDir, scope.roleId, packId, relativePath, this.cacheRoot);
  }
  async cache(scope: DesktopPetOwnerScope, packId: string): Promise<ApiOperationResult> {
    packId = safePackId(packId); if (!packId) throw new Error("Invalid role or pack id.");
    const source = await this.queryCatalog(scope.roleId, scope.roleDir, this.cacheRoot, { packId }, 120_000);
    if (!source.packs.some(pack => pack.id === packId)) throw new Error("Desktop pet pack is not available from the shared role source.");
    await syncImportedPackToRuntimeCache(scope.roleId, scope.roleDir, packId, this.cacheRoot);
    const catalog = listDesktopPetPacks(scope.roleId, scope.roleDir, this.cacheRoot, { includeSharedSource: false, packId });
    const pack = catalog.packs.find(item => item.id === packId); if (!pack) throw new Error("Desktop pet pack was not readable from the runtime cache.");
    this.context.publishEvent?.("desktop_pet_catalog_changed", { personaId: scope.roleId, packId });
    return { status: 201, body: { code: 0, data: { personaId: scope.roleId, pack } } };
  }
  async import(scope: DesktopPetOwnerScope, payload: Buffer, fileName: string, contentType: string, options: { packId?: string; state?: string; name?: string }): Promise<ApiOperationResult> {
    if (!payload.length) throw new Error("Desktop pet import is empty.");
    const packId = importDesktopPetPack(scope.roleId, scope.roleDir, fileName, contentType, payload, options);
    await syncImportedPackToRuntimeCache(scope.roleId, scope.roleDir, packId, this.cacheRoot);
    const catalog = listDesktopPetPacks(scope.roleId, scope.roleDir, this.cacheRoot, { includeSharedSource: false, packId });
    const pack = catalog.packs.find(item => item.id === packId);
        if (!pack) {
          const target = path.join(scope.roleDir, "desktop-pet", "packs", packId);
          if (inside(path.join(scope.roleDir, "desktop-pet", "packs"), target)) {
            try {
              fs.rmSync(target, { recursive: true, force: true });
              recordDataMutationAudit({
                group: "role",
                event: "desktop_pet_pack_rollback_committed",
                owner: "desktop-pet-pack-import",
                action: "rollback-invalid-pack",
                target: { type: "desktop-pet-pack", id: packId },
                dataSource: { kind: "file", id: `roles/${scope.roleId}/desktop-pet/packs/${packId}` },
                outcome: "committed"
              });
            } catch (error) {
              recordDataMutationAudit({
                level: "error",
                group: "role",
                event: "desktop_pet_pack_rollback_failed",
                owner: "desktop-pet-pack-import",
                action: "rollback-invalid-pack",
                target: { type: "desktop-pet-pack", id: packId },
                dataSource: { kind: "file", id: `roles/${scope.roleId}/desktop-pet/packs/${packId}` },
                outcome: "failed",
                error
              });
              throw error;
            }
          }
          throw new Error(catalog.diagnostics.find(item => item.packId === packId)?.message || "Imported desktop pet pack is not runnable.");
        }

    this.context.publishEvent?.("desktop_pet_catalog_changed", { personaId: scope.roleId, packId: pack.id });
    return { status: 201, body: { code: 0, data: { personaId: scope.roleId, pack } } };
  }
  failure(error: unknown, status = 400, asset = false): ApiOperationResult {
    const transient = asset && isTransientAssetReadError(error);
    const resultStatus = transient ? 503 : status;
    return { status: resultStatus, ...(transient ? { headers: { "retry-after": "1" } } : {}), body: errorResponsePresentation({ code: -1, message: transient ? "Desktop pet asset is temporarily unavailable." : error instanceof Error ? error.message : String(error) }, resultStatus) };
  }
}

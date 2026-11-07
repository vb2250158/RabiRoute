import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { renameFileWithRetry } from "../shared/filePersistence.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginProfile } from "../plugin-kernel/profile.js";
import { builtinStartupPresentation, parseStartupTheme, type StartupPresentation, type StartupThemeDefinition } from "../shared/startupPresentation.js";

export function startupPresentationPath(stateRoot: string): string {
  return path.join(stateRoot, "data", "desktop", "startup-theme.json");
}
export type StartupPresentationInputs = Readonly<{ webTheme: string; profile: Pick<PluginProfile, "instances"> }>;
export type StartupPresentationResult = Readonly<{ state: "selected" | "default" | "unavailable"; themeId?: string; diagnostic?: string }>;

async function packageFile(root: string, relative: string): Promise<string> {
  const realRoot = await fs.realpath(root), target = await fs.realpath(path.resolve(root, relative));
  const child = path.relative(realRoot, target);
  if (!child || child === ".." || child.startsWith(".." + path.sep) || path.isAbsolute(child)) throw new Error("Theme resource is outside its package.");
  return target;
}
async function publishFile(target: string, bytes: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await renameFileWithRetry(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** One presentation owner, rebuilt from the effective profile and current desktop setting. No plugin activation. */
export function createStartupPresentationProjector(options: Readonly<{
  stateRoot: string; resolvePackage(pluginId: string, version: string): Promise<Readonly<{ sourceRoot: string }>>;
}>) {
  const target = startupPresentationPath(options.stateRoot);
  const assetRoot = path.resolve(options.stateRoot, "data", "desktop", "startup-theme-assets");
  const cleanupAssets = async (referenced: ReadonlySet<string>): Promise<boolean> => {
    try {
      const directory = await fs.lstat(assetRoot);
      // This directory is a derived owner namespace, never a redirect into user files.
      if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
      const entries = await fs.readdir(assetRoot, { withFileTypes: true });
      let complete = true;
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.ico$/.test(entry.name)) continue;
        const file = path.join(assetRoot, entry.name);
        if (referenced.has(file)) continue;
        try { await fs.unlink(file); } catch { complete = false; }
      }
      return complete;
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  };
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const project = async (read: () => Promise<StartupPresentationInputs>): Promise<StartupPresentationResult> => {
    try {
      const input = await read();
      if (input.webTheme === "system" || input.webTheme === "light" || input.webTheme === "dark") {
        if (input.webTheme === "system") await fs.rm(target, { force: true });
        else await publishFile(target, JSON.stringify(builtinStartupPresentation(input.webTheme)) + "\n");
        const clean = await cleanupAssets(new Set());
        return { state: input.webTheme === "system" ? "default" : "selected", themeId: input.webTheme,
          ...(!clean ? { diagnostic: "Some previous startup images could not be removed; the product appearance remains available." } : {}) };
      }
      let selected: { root: string; definition: StartupThemeDefinition } | undefined;
      let diagnostic: string | undefined;
      let ambiguous = false;
      for (const instance of input.profile.instances) {
        if (!instance.enabled) continue;
        try {
          const source = await options.resolvePackage(instance.package, instance.version);
          const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(source.sourceRoot, "rabi.plugin.json"), "utf8")));
          if (manifest.id !== instance.package || manifest.version !== instance.version) throw new Error("Installed theme identity changed.");
          const entry = manifest.entries.desktop;
          if (entry?.execution !== "declarative") continue;
          const declaration: unknown = JSON.parse(await fs.readFile(await packageFile(source.sourceRoot, entry.resource), "utf8"));
          if (!declaration || typeof declaration !== "object" || !Array.isArray((declaration as { contributions?: unknown }).contributions)) continue;
          for (const contribution of (declaration as { contributions: unknown[] }).contributions) {
            if (!contribution || typeof contribution !== "object" || (contribution as { kind?: unknown }).kind !== "theme") continue;
            const definition = parseStartupTheme((contribution as { value?: unknown }).value);
            if (!definition || definition.themeId !== input.webTheme) continue;
            if (selected) { ambiguous = true; diagnostic = "The selected startup theme is declared more than once; the product appearance remains available."; continue; }
            selected = { root: source.sourceRoot, definition };
          }
        } catch { diagnostic = "An installed startup theme resource is unavailable; other plugins remain usable."; }
      }
      if (!selected || ambiguous) {
        await fs.rm(target, { force: true });
        if (!await cleanupAssets(new Set())) diagnostic = "Some previous startup images could not be removed; the product appearance remains available.";
        return { state: "default", ...(diagnostic ? { diagnostic } : {}) };
      }
      const { root: themeRoot, definition } = selected;
      const { logo, frames, ...appearance } = definition;
      const value: StartupPresentation = { ...appearance };
      const referenced = new Set<string>();
      const copied = new Map<string, Promise<string>>();
      const copyLogo = (relative: string): Promise<string> => {
        const existing = copied.get(relative);
        if (existing) return existing;
        const copying = (async () => {
          const bytes = await fs.readFile(await packageFile(themeRoot, relative));
          const digest = createHash("sha256").update(bytes).digest("hex");
          const logoPath = path.join(assetRoot, digest + ".ico");
          await publishFile(logoPath, bytes);
          referenced.add(logoPath);
          return logoPath;
        })();
        copied.set(relative, copying);
        return copying;
      };
      if (logo) {
        try { Object.assign(value, { logoPath: await copyLogo(logo) }); }
        catch { diagnostic = "The selected startup logo is unavailable; the product logo remains available."; }
      }
      if (frames) {
        const projectedFrames: Array<{ logoPath: string; durationMs: number }> = [];
        for (const frame of frames) {
          try { projectedFrames.push({ logoPath: await copyLogo(frame.logo), durationMs: frame.durationMs }); }
          catch { diagnostic = "A startup animation frame is unavailable; available frames and the product logo remain usable."; }
        }
        if (projectedFrames.length) Object.assign(value, { frames: projectedFrames });
      }
      await publishFile(target, JSON.stringify(value) + "\n");
      if (!await cleanupAssets(referenced)) diagnostic = "Some previous startup images could not be removed; the selected appearance remains available.";
      return { state: "selected", themeId: value.themeId, ...(diagnostic ? { diagnostic } : {}) };
    } catch {
      try { await fs.rm(target, { force: true }); } catch { /* Local presentation diagnostics cannot block Manager startup. */ }
      return { state: "unavailable", diagnostic: "Startup appearance could not be refreshed; Manager features remain available." };
    }
  };
  return Object.freeze({ refresh(read: () => Promise<StartupPresentationInputs>): Promise<StartupPresentationResult> {
    if (closed) return Promise.resolve({ state: "unavailable", diagnostic: "Startup appearance owner has stopped." });
    const next = tail.then(() => project(read)); tail = next; return next;
  }, stop(): Promise<void> { closed = true; return tail.then(() => {}); } });
}

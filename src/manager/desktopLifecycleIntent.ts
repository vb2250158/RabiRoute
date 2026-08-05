import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";

export type DesktopLifecycleDesiredState = "running" | "stopped";

export type DesktopLifecycleIntent = {
  schemaVersion: 1;
  desiredState: DesktopLifecycleDesiredState;
  updatedAt: string;
  source: string;
};

export function desktopLifecycleIntentPath(rootDir: string): string {
  return path.join(rootDir, "data", "runtime", "desktop-lifecycle-intent.json");
}

export function readDesktopLifecycleIntent(rootDir: string): DesktopLifecycleIntent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopLifecycleIntentPath(rootDir), "utf8")) as Partial<DesktopLifecycleIntent>;
    if (
      parsed.schemaVersion !== 1
      || (parsed.desiredState !== "running" && parsed.desiredState !== "stopped")
      || typeof parsed.updatedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.updatedAt))
      || typeof parsed.source !== "string"
      || parsed.source.trim().length === 0
    ) return null;
    return {
      schemaVersion: 1,
      desiredState: parsed.desiredState,
      updatedAt: parsed.updatedAt,
      source: parsed.source
    };
  } catch {
    return null;
  }
}

export function writeDesktopLifecycleIntent(
  rootDir: string,
  desiredState: DesktopLifecycleDesiredState,
  source: string
): DesktopLifecycleIntent {
  const normalizedSource = source.trim();
  if (!normalizedSource) throw new Error("Desktop lifecycle intent source is required.");
  const intent: DesktopLifecycleIntent = {
    schemaVersion: 1,
    desiredState,
    updatedAt: new Date().toISOString(),
    source: normalizedSource
  };
  atomicWriteFileSync(desktopLifecycleIntentPath(rootDir), `${JSON.stringify(intent, null, 2)}\n`);
  return intent;
}

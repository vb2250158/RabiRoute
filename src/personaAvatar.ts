import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PERSONA_AVATAR_CONTENT_TYPES,
  PERSONA_AVATAR_MAX_BYTES,
  type PersonaAvatarContentType
} from "./shared/personaAvatarContract.js";

const PERSONA_CONFIG_FILE = "personaConfig.json";
const PERSONA_FILE = "persona.md";
const MANAGED_AVATAR_PATTERN = /^avatar(?:-[a-f0-9]{12})?\.(?:png|jpg|webp|gif)$/i;

const AVATAR_EXTENSIONS: Record<PersonaAvatarContentType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

type JsonObject = Record<string, unknown>;

export type PersonaAvatarInfo = {
  configured: boolean;
  fileName?: string;
  filePath?: string;
  contentType?: PersonaAvatarContentType;
  version?: string;
};

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readConfig(filePath: string, strict = false): JsonObject {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isJsonObject(parsed)) return parsed;
    if (strict) throw new Error("personaConfig.json must contain a JSON object.");
  } catch (error) {
    if (strict) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot update malformed personaConfig.json: ${detail}`);
    }
  }
  return {};
}

function atomicWrite(filePath: string, body: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, body);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function contentTypeForExtension(extension: string): PersonaAvatarContentType | undefined {
  return PERSONA_AVATAR_CONTENT_TYPES.find(contentType => AVATAR_EXTENSIONS[contentType] === extension);
}

function normalizedContentType(contentType: string): PersonaAvatarContentType | undefined {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  return PERSONA_AVATAR_CONTENT_TYPES.find(candidate => candidate === normalized);
}

function hasExpectedSignature(contentType: PersonaAvatarContentType, body: Buffer): boolean {
  if (contentType === "image/png") return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/jpeg") return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (contentType === "image/webp") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  return body.subarray(0, 6).toString("ascii") === "GIF87a" || body.subarray(0, 6).toString("ascii") === "GIF89a";
}

function safeAvatarPath(roleDir: string, value: unknown): string | undefined {
  const fileName = typeof value === "string" ? value.trim() : "";
  if (!fileName || path.basename(fileName) !== fileName) return undefined;
  const extension = path.extname(fileName).toLowerCase();
  if (!contentTypeForExtension(extension)) return undefined;
  const candidate = path.resolve(roleDir, fileName);
  const relative = path.relative(path.resolve(roleDir), candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return candidate;
}

function requirePersona(roleDir: string): void {
  if (!fs.existsSync(path.join(roleDir, PERSONA_FILE))) {
    throw new Error(`Persona does not exist: ${path.basename(roleDir)}`);
  }
}

function managedAvatarPath(roleDir: string, fileName: string | undefined): string | undefined {
  return fileName && MANAGED_AVATAR_PATTERN.test(fileName) ? path.join(roleDir, fileName) : undefined;
}

function removeFileIfPresent(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readPersonaAvatar(roleDir: string): PersonaAvatarInfo {
  const config = readConfig(path.join(roleDir, PERSONA_CONFIG_FILE));
  const filePath = safeAvatarPath(roleDir, config.avatar);
  if (!filePath) return { configured: false };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { configured: false };
    const contentType = contentTypeForExtension(path.extname(filePath).toLowerCase());
    if (!contentType) return { configured: false };
    return {
      configured: true,
      fileName: path.basename(filePath),
      filePath,
      contentType,
      version: `${Math.trunc(stat.mtimeMs)}-${stat.size}`
    };
  } catch {
    return { configured: false };
  }
}

export function savePersonaAvatar(roleDir: string, contentTypeValue: string, body: Buffer): PersonaAvatarInfo {
  requirePersona(roleDir);
  const contentType = normalizedContentType(contentTypeValue);
  if (!contentType) throw new Error("Avatar must be PNG, JPEG, WebP, or GIF.");
  if (body.length === 0) throw new Error("Avatar image is empty.");
  if (body.length > PERSONA_AVATAR_MAX_BYTES) throw new Error("Avatar image exceeds the 5 MB limit.");
  if (!hasExpectedSignature(contentType, body)) throw new Error("Avatar content does not match its image type.");

  const configPath = path.join(roleDir, PERSONA_CONFIG_FILE);
  const config = readConfig(configPath, true);
  const previousFileName = typeof config.avatar === "string" ? config.avatar : undefined;
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const fileName = `avatar-${digest}${AVATAR_EXTENSIONS[contentType]}`;
  const filePath = path.join(roleDir, fileName);

  if (!fs.existsSync(filePath)) atomicWrite(filePath, body);
  try {
    atomicWrite(configPath, JSON.stringify({ ...config, avatar: fileName }, null, 2));
  } catch (error) {
    if (previousFileName !== fileName) removeFileIfPresent(filePath);
    throw error;
  }

  const previousManagedPath = managedAvatarPath(roleDir, previousFileName);
  if (previousManagedPath !== filePath) removeFileIfPresent(previousManagedPath);
  return readPersonaAvatar(roleDir);
}

export function removePersonaAvatar(roleDir: string): void {
  requirePersona(roleDir);
  const configPath = path.join(roleDir, PERSONA_CONFIG_FILE);
  const config = readConfig(configPath, true);
  const previousFileName = typeof config.avatar === "string" ? config.avatar : undefined;
  delete config.avatar;
  atomicWrite(configPath, JSON.stringify(config, null, 2));
  removeFileIfPresent(managedAvatarPath(roleDir, previousFileName));
}

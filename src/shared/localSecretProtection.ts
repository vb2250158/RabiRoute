import { getTimeoutMs } from "./timeoutSettings.js";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

export type LocalSecretProtector = Readonly<{
  scheme: string;
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
}>;

function trustedWindowsPowerShellPath(): string {
  const systemDrive = String(process.env.SystemDrive || "C:").trim().toUpperCase();
  if (!/^[A-Z]:$/.test(systemDrive)) throw new Error("Windows system drive is invalid.");
  const executable = path.join(systemDrive, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const status = fs.lstatSync(executable);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("Windows PowerShell executable is unavailable.");
  return executable;
}

function powerShellDpapi(script: string, input: string): string {
  const executable = trustedWindowsPowerShellPath();
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: getTimeoutMs("backend.shared.localSecretProtection.powerShellDpapi.spawnSync.timeout", 15_000),
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0 || result.error || !String(result.stdout || "").trim()) {
    throw new Error("Windows DPAPI operation failed.");
  }
  return String(result.stdout).trim();
}

const protectScript = [
    "Add-Type -AssemblyName System.Security",
    "$plain=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())",
    "$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($cipher))"
  ].join(";");
const unprotectScript = [
    "Add-Type -AssemblyName System.Security",
    "$cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))"
  ].join(";");
function windowsProtector(): LocalSecretProtector {
  return {
    scheme: "windows-dpapi-current-user",
    protect: plaintext => powerShellDpapi(protectScript, plaintext),
    unprotect: protectedValue => Buffer.from(powerShellDpapi(unprotectScript, protectedValue), "base64").toString("utf8")
  };
}

function localKeyProtector(dataDir: string, keyFileName: string): LocalSecretProtector {
  const keyPath = path.join(dataDir, keyFileName);
  const readKey = (): Buffer => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    if (!fs.existsSync(keyPath)) {
      try {
        fs.writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
        recordDataMutationAudit({
          group: "security",
          event: "local_secret_key_created",
          owner: "local-secret-protection",
          action: "create-key",
          target: { type: "encryption-key", id: keyFileName },
          dataSource: { kind: "file", id: keyFileName },
          outcome: "committed"
        });
      } catch (error) {
        if (!fs.existsSync(keyPath)) {
          recordDataMutationAudit({
            level: "error",
            group: "security",
            event: "local_secret_key_create_failed",
            owner: "local-secret-protection",
            action: "create-key",
            target: { type: "encryption-key", id: keyFileName },
            dataSource: { kind: "file", id: keyFileName },
            outcome: "failed",
            error
          });
          throw error;
        }
      }
    }
    const status = fs.lstatSync(keyPath);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("Local secret protection key is not a regular file.");
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
      throw new Error("Local secret protection key is owned by another user.");
    }
    fs.chmodSync(keyPath, 0o600);
    const key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw new Error("Local secret protection key is invalid.");
    return key;
  };
  return {
    scheme: "local-aes-256-gcm-v1",
    protect: plaintext => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", readKey(), iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString("base64")).join(".");
    },
    unprotect: protectedValue => {
      const [ivText, tagText, encryptedText] = protectedValue.split(".");
      if (!ivText || !tagText || !encryptedText) throw new Error("Protected local secret payload is invalid.");
      const decipher = createDecipheriv("aes-256-gcm", readKey(), Buffer.from(ivText, "base64"));
      decipher.setAuthTag(Buffer.from(tagText, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, "base64")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

export function createLocalSecretProtector(
  dataDir: string,
  keyFileName = ".local-secrets.key"
): LocalSecretProtector {
  return process.platform === "win32" ? windowsProtector() : localKeyProtector(dataDir, keyFileName);
}

export type AsyncLocalSecretProtector = Readonly<{
  scheme: string;
  protect(plaintext: string, signal?: AbortSignal): Promise<string>;
  unprotect(protectedValue: string, signal?: AbortSignal): Promise<string>;
}>;

/** Owns the child until close, including cancellation and malformed output. */
export function runDpapiChild(
  child: ChildProcess, input: string, signal?: AbortSignal,
  timeoutMs = getTimeoutMs("backend.shared.localSecretProtection.powerShellDpapi.spawnSync.timeout", 15_000),
  maxBuffer = 4 * 1024 * 1024
): Promise<string> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    const stop = (error: Error) => {
      failure ??= error;
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const abort = () => stop(new Error("Windows DPAPI operation cancelled."));
    const timer = setTimeout(() => stop(new Error("Windows DPAPI operation timed out.")), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) stop(new Error("Windows DPAPI output exceeded its limit."));
      else chunks.push(Buffer.from(chunk));
    });
    // Consume stderr without retaining or exposing potentially sensitive data.
    child.stderr?.resume();
    child.once("error", () => { failure ??= new Error("Windows DPAPI operation failed."); });
    child.stdin?.on("error", () => { failure ??= new Error("Windows DPAPI operation failed."); });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (failure || code !== 0 || !output) reject(failure ?? new Error("Windows DPAPI operation failed."));
      else resolve(output);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin?.end(input);
  });
}

export function createAsyncLocalSecretProtector(dataDir: string, keyFileName = ".local-secrets.key"): AsyncLocalSecretProtector {
  if (process.platform !== "win32") {
    const original = localKeyProtector(dataDir, keyFileName);
    return { scheme: original.scheme, async protect(value, signal) { signal?.throwIfAborted(); return original.protect(value); },
      async unprotect(value, signal) { signal?.throwIfAborted(); return original.unprotect(value); } };
  }
  const execute = (script: string, input: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const child = spawn(trustedWindowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return runDpapiChild(child, input, signal);
  };
  return { scheme: "windows-dpapi-current-user", protect: (value, signal) => execute(protectScript, value, signal),
    async unprotect(value, signal) { return Buffer.from(await execute(unprotectScript, value, signal), "base64").toString("utf8"); } };
}

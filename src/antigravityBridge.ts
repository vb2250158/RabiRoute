import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * `promisify(execFile)` carries several overloads, none of which line up with
 * the single signature the bridge uses. Widening it once here keeps the
 * dependency type honest about the actual call shape.
 */
const execFileAsync: AntigravityExecFile = promisify(execFile) as unknown as AntigravityExecFile;

/**
 * Antigravity delivery bridge.
 *
 * Delivery runs through the host's own `agy agentapi` subcommands rather than
 * driving the desktop renderer. `send-message` posts with system-message
 * identity and `new-conversation` starts a session with user-input identity, so
 * a caller can pick the semantic that matches the payload.
 *
 * Both the gRPC address and the CSRF token belong to the running instance:
 * the address is the language server's listening port and the token is minted
 * per launch, so both are read at call time instead of being configured.
 */

export type AntigravityDeliveryKind = "system-message" | "new-conversation";

export type AntigravityDeliveryRequest = {
  /** Prompt text to deliver. */
  prompt: string;
  /** Existing conversation to post into. Required for `system-message`. */
  conversationId?: string;
  /** Delivery semantic. Defaults to `system-message` when a conversation is given. */
  kind?: AntigravityDeliveryKind;
  /** Optional conversation title, forwarded to the host CLI. */
  title?: string;
  /** Model tier for `new-conversation`. */
  model?: "flash_lite" | "flash" | "pro";
};

export type AntigravityDeliveryResult = {
  conversationId: string;
  kind: AntigravityDeliveryKind;
  /** Raw `response` object returned by the host CLI. */
  raw: unknown;
};

export type AntigravityEnvironment = {
  lsAddress: string;
  csrfToken: string;
  projectId: string;
};

/**
 * The narrow slice of `execFile` this bridge actually calls. Declaring the
 * signature explicitly keeps `promisify(execFile)`'s overload set out of the
 * dependency contract, so callers can inject a plain stub.
 */
export type AntigravityExecFile = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<{ stdout?: unknown; stderr?: unknown }>;

export type AntigravityBridgeDependencies = {
  execFile?: AntigravityExecFile;
  readFile?: typeof fs.promises.readFile;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

const LANGUAGE_SERVER_IMAGE = "language_server.exe";
const DEFAULT_PROJECT_ID = "outside-of-project";
const DEFAULT_CSRF_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 90_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 15_000;

function trimToUndefined(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the `agy` executable. An explicit environment override wins; otherwise
 * the per-user install location is used, falling back to a PATH lookup by name.
 */
export function resolveAntigravityCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = trimToUndefined(env.ANTIGRAVITY_AGENTAPI_EXE)
    ?? trimToUndefined(env.ANTIGRAVITY_AGENT);
  if (override) return override;
  const localAppData = trimToUndefined(env.LOCALAPPDATA);
  if (localAppData) {
    return path.join(localAppData, "agy", "bin", "agy.exe");
  }
  return "agy";
}

/** The Antigravity main-process log that carries the per-launch CSRF token. */
export function antigravityMainLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const roaming = trimToUndefined(env.APPDATA)
    ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "Antigravity", "logs", "main.log");
}

/**
 * Read the CSRF token minted for the current language server launch. The host
 * appends one `--csrf_token <uuid>` per startup, so the last match is the live one.
 */
export async function readAntigravityCsrfToken(
  dependencies: AntigravityBridgeDependencies = {}
): Promise<string> {
  const readFile = dependencies.readFile ?? fs.promises.readFile;
  const logPath = antigravityMainLogPath(dependencies.env);
  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch {
    throw new Error(
      `Antigravity is not reporting a CSRF token: ${logPath} could not be read. `
      + "Start Antigravity Desktop before delivering."
    );
  }
  const matches = [...contents.matchAll(/--csrf_token\s+([0-9a-f-]{36})/gi)];
  const token = matches.at(-1)?.[1];
  if (!token) {
    throw new Error(`No --csrf_token entry was found in ${logPath}.`);
  }
  return token;
}

/**
 * Discover the language server's gRPC port by matching the listening sockets of
 * the running `language_server` processes. The UI port is excluded because it
 * serves HTTPS rather than gRPC.
 */
export async function discoverAntigravityLsAddress(
  dependencies: AntigravityBridgeDependencies = {}
): Promise<string> {
  if (dependencies.platform && dependencies.platform !== "win32") {
    throw new Error("Antigravity adapter discovery is only implemented for Windows.");
  }
  const exec = dependencies.execFile ?? execFileAsync;

  let taskOutput: string;
  try {
    const result = await exec(
      "tasklist",
      ["/FI", `IMAGENAME eq ${LANGUAGE_SERVER_IMAGE}`, "/FO", "CSV", "/NH"],
      { timeout: DEFAULT_CONFIG_TIMEOUT_MS, windowsHide: true }
    );
    taskOutput = String(result.stdout ?? "");
  } catch (error) {
    throw new Error(`Could not list ${LANGUAGE_SERVER_IMAGE}: ${describeError(error)}`);
  }

  const pids = new Set<string>();
  for (const line of taskOutput.split(/\r?\n/)) {
    const match = line.match(/^"[^"]+","(\d+)"/);
    if (match) pids.add(match[1]);
  }
  if (!pids.size) {
    throw new Error("Antigravity language server is not running. Start Antigravity Desktop first.");
  }

  let netOutput: string;
  try {
    const result = await exec("netstat", ["-ano"], { timeout: DEFAULT_CONFIG_TIMEOUT_MS, windowsHide: true });
    netOutput = String(result.stdout ?? "");
  } catch (error) {
    throw new Error(`Could not inspect listening sockets: ${describeError(error)}`);
  }

  const candidates: number[] = [];
  for (const line of netOutput.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const localAddress = columns[1] ?? "";
    const pid = columns.at(-1) ?? "";
    if (!pids.has(pid)) continue;
    const portMatch = localAddress.match(/^127\.0\.0\.1:(\d+)$/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (port !== antigravityUiPort()) candidates.push(port);
  }

  if (!candidates.length) {
    throw new Error("No gRPC port was found for the running Antigravity language server.");
  }
  return `127.0.0.1:${candidates[0]}`;
}

/** The language server's HTTPS/UI port, distinct from the gRPC port. */
export function antigravityUiPort(): number {
  return 7299;
}

/** Resolve everything `agy agentapi` needs to reach the running instance. */
export async function resolveAntigravityEnvironment(
  dependencies: AntigravityBridgeDependencies = {}
): Promise<AntigravityEnvironment> {
  const [lsAddress, csrfToken] = await Promise.all([
    discoverAntigravityLsAddress(dependencies),
    readAntigravityCsrfToken(dependencies)
  ]);
  const projectId = trimToUndefined(dependencies.env?.ANTIGRAVITY_PROJECT_ID)
    ?? trimToUndefined(process.env.ANTIGRAVITY_PROJECT_ID)
    ?? DEFAULT_PROJECT_ID;
  return { lsAddress, csrfToken, projectId };
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.slice(0, 300);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `agy agentapi` reports failures as a JSON `error` field on stdout with a
 * non-zero exit code, so a rejected call still parses.
 */
async function runAgentApi(
  args: string[],
  environment: AntigravityEnvironment,
  dependencies: AntigravityBridgeDependencies
): Promise<{ response?: unknown; error?: string }> {
  const exec = dependencies.execFile ?? execFileAsync;
  const cliPath = resolveAntigravityCliPath(dependencies.env);
  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: environment.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: environment.csrfToken,
    ANTIGRAVITY_PROJECT_ID: environment.projectId
  };

  let stdout = "";
  try {
    const result = await exec(cliPath, ["agentapi", ...args], {
      timeout: DEFAULT_DELIVERY_TIMEOUT_MS,
      env,
      windowsHide: true
    });
    stdout = String(result.stdout ?? "");
  } catch (error) {
    const withOutput = error as { stdout?: unknown; stderr?: unknown };
    stdout = String(withOutput.stdout ?? "");
    if (!stdout.trim()) {
      throw new Error(`agy agentapi ${args[0]} failed: ${describeError(error)}`);
    }
  }

  try {
    return JSON.parse(stdout) as { response?: unknown; error?: string };
  } catch {
    throw new Error(`agy agentapi ${args[0]} returned unparseable output.`);
  }
}

function extractConversationId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const send = (response as { sendMessage?: { recipientId?: unknown } }).sendMessage;
  const created = (response as { newConversation?: { conversationId?: unknown } }).newConversation;
  const fromSend = trimToUndefined(send?.recipientId);
  if (fromSend) return fromSend;
  return trimToUndefined(created?.conversationId);
}

/**
 * Deliver a prompt into Antigravity.
 *
 * `system-message` posts into an existing conversation and lands with
 * `source: SYSTEM` identity, which is the host's documented async-notification
 * semantic. `new-conversation` starts a fresh session whose first turn carries
 * `source: USER_EXPLICIT` identity.
 */
export async function deliverAntigravityPrompt(
  request: AntigravityDeliveryRequest,
  environment: AntigravityEnvironment,
  dependencies: AntigravityBridgeDependencies = {}
): Promise<AntigravityDeliveryResult> {
  const prompt = request.prompt ?? "";
  if (!prompt.trim()) throw new Error("Antigravity delivery requires a non-empty prompt.");

  const kind: AntigravityDeliveryKind = request.kind
    ?? (request.conversationId ? "system-message" : "new-conversation");

  if (kind === "system-message") {
    const conversationId = trimToUndefined(request.conversationId);
    if (!conversationId) {
      throw new Error("Antigravity system-message delivery requires a conversation id.");
    }
    const args = ["send-message"];
    if (request.title?.trim()) args.push(`--title=${request.title.trim()}`);
    args.push(conversationId, prompt);

    const parsed = await runAgentApi(args, environment, dependencies);
    if (parsed.error) throw new Error(`Antigravity send-message was rejected: ${parsed.error}`);
    return { conversationId, kind, raw: parsed.response };
  }

  const args = ["new-conversation"];
  if (request.model) args.push(`--model=${request.model}`);
  if (request.title?.trim()) args.push(`--title=${request.title.trim()}`);
  args.push(prompt);

  const parsed = await runAgentApi(args, environment, dependencies);
  if (parsed.error) throw new Error(`Antigravity new-conversation was rejected: ${parsed.error}`);
  const conversationId = extractConversationId(parsed.response);
  if (!conversationId) {
    throw new Error("Antigravity new-conversation did not return a conversation id.");
  }
  return { conversationId, kind, raw: parsed.response };
}

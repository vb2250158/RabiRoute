import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  antigravityMainLogPath,
  antigravityUiPort,
  deliverAntigravityPrompt,
  discoverAntigravityLsAddress,
  readAntigravityCsrfToken,
  resolveAntigravityCliPath,
  resolveAntigravityEnvironment,
  type AntigravityEnvironment,
  type AntigravityExecFile
} from "./antigravityBridge.js";

type ExecResult = { stdout: string; stderr?: string };

/**
 * Build an `execFile` stand-in that answers by command, so discovery can be
 * tested without a running Antigravity instance.
 */
function fakeExecFile(
  answers: Array<{ match: (file: string, args: readonly string[]) => boolean; result: ExecResult | Error }>
): {
  calls: Array<{ file: string; args: readonly string[]; options?: Record<string, unknown> }>;
  exec: AntigravityExecFile;
} {
  const calls: Array<{ file: string; args: readonly string[]; options?: Record<string, unknown> }> = [];
  const exec: AntigravityExecFile = async (file, args, options) => {
    calls.push({ file, args, options });
    const answer = answers.find((candidate) => candidate.match(file, args));
    if (!answer) throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    if (answer.result instanceof Error) throw answer.result;
    return answer.result;
  };
  return { calls, exec };
}

const ENVIRONMENT: AntigravityEnvironment = {
  lsAddress: "127.0.0.1:7300",
  csrfToken: "11111111-2222-3333-4444-555555555555",
  projectId: "outside-of-project"
};

test("the CLI path honours an explicit override before the per-user install", () => {
  assert.equal(resolveAntigravityCliPath({ ANTIGRAVITY_AGENTAPI_EXE: "D:\\tools\\agy.exe" }), "D:\\tools\\agy.exe");
  assert.equal(
    resolveAntigravityCliPath({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }),
    path.join("C:\\Users\\x\\AppData\\Local", "agy", "bin", "agy.exe")
  );
  // With no environment at all the bare name is left for PATH resolution.
  assert.equal(resolveAntigravityCliPath({}), "agy");
});

test("the main log path is derived from APPDATA", () => {
  assert.equal(
    antigravityMainLogPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }),
    path.join("C:\\Users\\x\\AppData\\Roaming", "Antigravity", "logs", "main.log")
  );
});

/** Write a log at the location the bridge derives from APPDATA. */
function writeMainLog(appDataDir: string, contents: string): string {
  const logPath = antigravityMainLogPath({ APPDATA: appDataDir });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, contents, "utf8");
  return logPath;
}

test("the CSRF token is read from the newest startup entry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-csrf-"));
  const older = "aaaaaaaa-1111-2222-3333-444444444444";
  const newer = "bbbbbbbb-5555-6666-7777-888888888888";
  // The host appends one entry per launch, so the last match is the live token.
  writeMainLog(root, `[info] launching --csrf_token ${older} --other\n[info] relaunching --csrf_token ${newer} --other\n`);
  try {
    assert.equal(await readAntigravityCsrfToken({ readFile: fs.promises.readFile, env: { APPDATA: root } }), newer);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing main log reports that the host must be started", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-csrf-missing-"));
  try {
    await assert.rejects(
      readAntigravityCsrfToken({ readFile: fs.promises.readFile, env: { APPDATA: root } }),
      /Start Antigravity Desktop before delivering/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a main log without a token entry is rejected rather than returning empty", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-csrf-empty-"));
  writeMainLog(root, "[info] started without a token\n");
  try {
    await assert.rejects(
      readAntigravityCsrfToken({ readFile: fs.promises.readFile, env: { APPDATA: root } }),
      /No --csrf_token entry was found/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovery picks the language server's gRPC port and skips the UI port", async () => {
  const { exec, calls } = fakeExecFile([
    {
      match: (file) => file === "tasklist",
      result: { stdout: '"language_server.exe","4242","Console","1","100,000 K"\n' }
    },
    {
      match: (file) => file === "netstat",
      result: {
        stdout: [
          "  TCP    127.0.0.1:7300         0.0.0.0:0              LISTENING       4242",
          // The UI port serves HTTPS, not gRPC, and must never be chosen.
          `  TCP    127.0.0.1:${antigravityUiPort()}         0.0.0.0:0              LISTENING       4242`,
          // A socket owned by another process is not the language server.
          "  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       1111",
          "  TCP    127.0.0.1:7301         0.0.0.0:0              LISTENING       4242"
        ].join("\n")
      }
    }
  ]);

  assert.equal(await discoverAntigravityLsAddress({ execFile: exec, platform: "win32" }), "127.0.0.1:7300");
  assert.ok(calls.some((call) => call.file === "netstat"));
});

test("discovery explains that the host is not running when no process matches", async () => {
  const { exec } = fakeExecFile([
    { match: (file) => file === "tasklist", result: { stdout: "INFO: No tasks are running which match the specified criteria.\n" } }
  ]);
  await assert.rejects(
    discoverAntigravityLsAddress({ execFile: exec, platform: "win32" }),
    /language server is not running/
  );
});

test("discovery refuses to guess on a platform it cannot inspect", async () => {
  await assert.rejects(
    discoverAntigravityLsAddress({ platform: "linux" }),
    /only implemented for Windows/
  );
});

test("the environment resolves address, token and project together", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-env-"));
  writeMainLog(root, "[info] --csrf_token 99999999-8888-7777-6666-555555555555\n");
  const { exec } = fakeExecFile([
    { match: (file) => file === "tasklist", result: { stdout: '"language_server.exe","4242","Console","1","1 K"\n' } },
    { match: (file) => file === "netstat", result: { stdout: "  TCP    127.0.0.1:7300    0.0.0.0:0    LISTENING    4242\n" } }
  ]);
  try {
    const environment = await resolveAntigravityEnvironment({
      execFile: exec,
      readFile: fs.promises.readFile,
      platform: "win32",
      env: { APPDATA: root }
    });
    assert.equal(environment.lsAddress, "127.0.0.1:7300");
    assert.equal(environment.csrfToken, "99999999-8888-7777-6666-555555555555");
    // The default project id is what the host itself reports for conversations
    // started outside a workspace.
    assert.equal(environment.projectId, "outside-of-project");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("system-message delivery targets the named conversation and passes the token through the environment", async () => {
  let seenEnv: Record<string, unknown> | undefined;
  const { exec, calls } = fakeExecFile([
    {
      match: (file) => file.endsWith("agy.exe") || file === "agy",
      result: { stdout: JSON.stringify({ response: { sendMessage: { recipientId: "conv-1" } } }) }
    }
  ]);
  const wrapped: AntigravityExecFile = async (file, args, options) => {
    seenEnv = options.env as Record<string, unknown>;
    return exec(file, args, options);
  };

  const result = await deliverAntigravityPrompt(
    { prompt: "hello", conversationId: "conv-1" },
    ENVIRONMENT,
    { execFile: wrapped, env: { LOCALAPPDATA: "C:\\x" } }
  );

  assert.equal(result.kind, "system-message");
  assert.equal(result.conversationId, "conv-1");
  // Target identity is an explicit argument, which is what removes the risk of
  // writing into whichever conversation the UI happens to have open.
  assert.deepEqual(calls[0]?.args, ["agentapi", "send-message", "conv-1", "hello"]);
  assert.equal(seenEnv?.ANTIGRAVITY_LS_ADDRESS, "127.0.0.1:7300");
  assert.equal(seenEnv?.ANTIGRAVITY_CSRF_TOKEN, ENVIRONMENT.csrfToken);
  assert.equal(seenEnv?.ANTIGRAVITY_PROJECT_ID, "outside-of-project");
});

test("an empty prompt is rejected before any command runs", async () => {
  const { exec, calls } = fakeExecFile([]);
  await assert.rejects(
    deliverAntigravityPrompt({ prompt: "   ", conversationId: "conv-1" }, ENVIRONMENT, { execFile: exec }),
    /requires a non-empty prompt/
  );
  assert.equal(calls.length, 0);
});

test("system-message delivery refuses to run without a conversation id", async () => {
  const { exec, calls } = fakeExecFile([]);
  await assert.rejects(
    deliverAntigravityPrompt(
      { prompt: "hello", conversationId: "" , kind: "system-message" },
      ENVIRONMENT,
      { execFile: exec }
    ),
    /requires a conversation id/
  );
  assert.equal(calls.length, 0);
});

test("new-conversation returns the created conversation id and forwards the model", async () => {
  const { exec, calls } = fakeExecFile([
    {
      match: () => true,
      result: { stdout: JSON.stringify({ response: { newConversation: { conversationId: "conv-new" } } }) }
    }
  ]);

  const result = await deliverAntigravityPrompt(
    { prompt: "start", kind: "new-conversation", model: "pro", title: "Rabi task" },
    ENVIRONMENT,
    { execFile: exec, env: { LOCALAPPDATA: "C:\\x" } }
  );

  assert.equal(result.conversationId, "conv-new");
  assert.equal(result.kind, "new-conversation");
  assert.deepEqual(calls[0]?.args, [
    "agentapi", "new-conversation", "--model=pro", "--title=Rabi task", "start"
  ]);
});

test("delivery kind defaults to reuse an existing conversation when one is given", async () => {
  const { exec } = fakeExecFile([
    { match: () => true, result: { stdout: JSON.stringify({ response: { sendMessage: { recipientId: "conv-9" } } }) } }
  ]);
  const result = await deliverAntigravityPrompt({ prompt: "hi", conversationId: "conv-9" }, ENVIRONMENT, { execFile: exec });
  assert.equal(result.kind, "system-message");
});

test("new-conversation fails loudly when the host returns no id", async () => {
  const { exec } = fakeExecFile([{ match: () => true, result: { stdout: JSON.stringify({ response: {} }) } }]);
  await assert.rejects(
    deliverAntigravityPrompt({ prompt: "start", kind: "new-conversation" }, ENVIRONMENT, { execFile: exec }),
    /did not return a conversation id/
  );
});

test("a rejected payload surfaces the host's own error text", async () => {
  const { exec } = fakeExecFile([
    { match: () => true, result: { stdout: JSON.stringify({ error: "conversation not found" }) } }
  ]);
  await assert.rejects(
    deliverAntigravityPrompt({ prompt: "hi", conversationId: "gone" }, ENVIRONMENT, { execFile: exec }),
    /conversation not found/
  );
});

test("an error is still parsed from stdout because the host exits non-zero on rejection", async () => {
  // The CLI writes a JSON error to stdout and exits non-zero; treating the
  // thrown error as opaque would lose the only useful message.
  const { exec } = fakeExecFile([
    {
      match: () => true,
      result: Object.assign(new Error("Command failed: exit code 1"), {
        stdout: JSON.stringify({ error: "missing CSRF token" })
      })
    }
  ]);
  await assert.rejects(
    deliverAntigravityPrompt({ prompt: "hi", conversationId: "conv-1" }, ENVIRONMENT, { execFile: exec }),
    /missing CSRF token/
  );
});

test("a failure with no parseable stdout reports the underlying command error", async () => {
  const { exec } = fakeExecFile([
    { match: () => true, result: Object.assign(new Error("ENOENT: agy.exe not found"), { stdout: "" }) }
  ]);
  await assert.rejects(
    deliverAntigravityPrompt({ prompt: "hi", conversationId: "conv-1" }, ENVIRONMENT, { execFile: exec }),
    /ENOENT/
  );
});

test("unparseable output is reported instead of being treated as success", async () => {
  const { exec } = fakeExecFile([{ match: () => true, result: { stdout: "not json at all" } }]);
  await assert.rejects(
    deliverAntigravityPrompt({ prompt: "hi", conversationId: "conv-1" }, ENVIRONMENT, { execFile: exec }),
    /unparseable output/
  );
});

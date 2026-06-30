import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentReply, type AgentReplyOptions } from "./outbox.js";
import { resetWeComClientFactory, setWeComClientFactory, type WeComClientLike } from "./wecom.js";

function optionsWithRuntime(runtime: AgentReplyOptions["runtimes"][number]): AgentReplyOptions {
  return {
    rootDir: process.cwd(),
    routeRoot: "data/route",
    rolesRoot: "data/roles",
    runtimes: [runtime]
  };
}

async function withJsonServer<T>(
  handler: (body: Record<string, unknown>) => Record<string, unknown> | void,
  run: (url: string) => Promise<T>
): Promise<T> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const data = handler(body) ?? { ok: true, id: "fenne-reply-1" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await run(`http://127.0.0.1:${address.port}/api/fennenote/playback`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Codex output adapter accepts replies without turning them into drafts", async () => {
  const result = await handleAgentReply({
    routeProfileId: "main",
    text: "accepted by codex"
  }, optionsWithRuntime({
    id: "main",
    pipeline: {
      outputAdapter: "codex",
      outputPipeline: "codex"
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "Accepted by Codex output adapter.");
});

test("QQ output does not require original source context when target is explicit", async () => {
  const result = await handleAgentReply({
    routeProfileId: "main",
    text: "explicit private target",
    targetType: "private",
    userId: "10001"
  }, optionsWithRuntime({
    id: "main",
    pipeline: {
      outputAdapter: "qq",
      outputPipeline: "qq"
    },
    messageAdapterPolicies: {
      napcat: {
        outputEnabled: true,
        supportedOutputs: ["text"]
      }
    },
    napcatInstances: []
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
});

test("explicit group target can proactively use NapCat even when pipeline is codex", async () => {
  const result = await handleAgentReply({
    text: "项目进度提醒：请同步当前阻塞。",
    routeProfileId: "其他路由",
    targetType: "group",
    groupId: "20002"
  }, {
    rootDir: process.cwd(),
    routeRoot: "data/route",
    rolesRoot: "data/roles",
    runtimes: [
      {
        id: "AIPM群",
        targetGroupId: "20002",
        pipeline: {
          outputAdapter: "codex",
          outputPipeline: "codex",
          replyToSource: false
        },
        messageAdapterPolicies: {
          napcat: ({
            outputEnabled: true,
            outputMode: "draft",
            supportedOutputs: ["text"],
            allowedGroups: ["10001"],
            disabledPipelines: ["codex"]
          } as any)
        },
        napcatInstances: []
      },
      {
        id: "其他路由",
        targetGroupId: "30003",
        napcatInstances: []
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
  assert.equal(result.routeProfileId, "AIPM群");
  assert.equal(result.targetType, "group");
  assert.equal(result.groupId, "20002");
});

test("source reply resolves runtime route from message log and bypasses codex output pipeline", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-"));
  const routeDir = path.join(rootDir, "data", "route", "宇宙程序");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, "private-messages.jsonl"), `${JSON.stringify({
    time: 1,
    messageId: "private-1",
    userId: "10001",
    instanceId: "main-qq",
    adapterType: "napcat",
    botUserId: "99999",
    rawMessage: "推进一下项目进度"
  })}\n`, "utf8");

  const result = await handleAgentReply({
    text: "收到，我来推进。",
    replyContext: {
      routeProfileId: "programmer",
      routeKind: "private",
      targetType: "private",
      messageId: "private-1",
      userId: "10001",
      instanceId: "main-qq",
      outputAdapter: "codex",
      outputPipeline: "codex",
      replyToSource: false
    }
  }, {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [
      {
        id: "宇宙程序",
        dataDir: path.join("data", "route", "宇宙程序"),
        pipeline: {
          outputAdapter: "codex",
          outputPipeline: "codex",
          replyToSource: false
        },
        messageAdapterPolicies: {
          napcat: {
            outputEnabled: true,
            supportedOutputs: ["text"]
          }
        },
        napcatInstances: []
      },
      {
        id: "其他路由",
        dataDir: path.join("data", "route", "其他路由"),
        pipeline: {
          outputAdapter: "qq",
          outputPipeline: "qq"
        },
        napcatInstances: []
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "No NapCat HTTP endpoint is configured for this route.");
  assert.equal(result.routeProfileId, "宇宙程序");
  assert.equal(result.targetType, "private");
  assert.equal(result.userId, "10001");
  assert.equal(result.instanceId, "main-qq");
});

test("FenneNote voice output forwards agent reply to playback with original voice parameters", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-fennenote-"));
  let forwarded: Record<string, unknown> | undefined;
  const result = await withJsonServer((body) => {
    forwarded = body;
    return { ok: true, id: "fenne-play-1" };
  }, (url) => handleAgentReply({
    text: "已经走拉比回复端。",
    payload: {
      character_id: "rabi",
      language: "zh",
      emotion_vector: [0.2, 0.1, 0],
      worker_url: "http://127.0.0.1:8793/api/tts"
    },
    replyContext: {
      routeProfileId: "Rabi",
      routeKind: "voice_transcript",
      targetType: "voice_transcript",
      messageId: "voice-1",
      adapterType: "fennenote",
      speakerName: "秋雨",
      outputAdapter: "fennenote",
      outputPipeline: "fennenote",
      replyToSource: false
    }
  }, {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [
      {
        id: "拉比路由",
        routeProfiles: [{
          id: "Rabi",
          name: "Rabi route",
          pipeline: {
            outputAdapter: "codex",
            outputPipeline: "codex"
          }
        }],
        messageAdapterPolicies: {
          fennenote: {
            outputEnabled: true,
            supportedOutputs: ["text"]
          }
        }
      }
    ],
    fenneNotePlaybackUrl: url
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "Sent to FenneNote playback endpoint.");
  assert.equal(result.sentMessageId, "fenne-play-1");
  assert.ok(forwarded);
  assert.equal(forwarded.text, "已经走拉比回复端。");
  assert.equal(forwarded.adapterType, "fennenote");
  assert.equal(forwarded.routeProfileId, "Rabi");
  assert.equal(forwarded.messageId, "voice-1");
  assert.equal(forwarded.speakerName, "秋雨");
  assert.equal(forwarded.character_id, "rabi");
  assert.equal(forwarded.language, "zh");
  assert.equal(forwarded.worker_url, "http://127.0.0.1:8793/api/tts");
  assert.deepEqual(forwarded.emotion_vector, [0.2, 0.1, 0]);
});

test("FenneNote source reply resolves runtime by role fallback and voice transcript log", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-voice-"));
  const roleDir = path.join(rootDir, "data", "roles", "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "voice-transcripts.jsonl"), `${JSON.stringify({
    time: 1,
    messageId: "voice-log-1",
    adapterType: "fennenote",
    source: "fennenote",
    speakerName: "秋雨",
    rawMessage: "语音输入"
  })}\n`, "utf8");

  let forwarded: Record<string, unknown> | undefined;
  const result = await withJsonServer((body) => {
    forwarded = body;
    return { ok: true, id: "fenne-play-2" };
  }, (url) => handleAgentReply({
    text: "走拉比回复端。",
    replyContext: {
      runtimeRouteId: "拉比路由",
      gatewayId: "拉比路由",
      routeProfileId: "Rabi",
      routeKind: "voice_transcript",
      targetType: "voice_transcript",
      messageId: "voice-log-1",
      adapterType: "fennenote",
      speakerName: "秋雨",
      outputAdapter: "fennenote",
      outputPipeline: "fennenote",
      replyToSource: false
    }
  }, {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [
      {
        id: "拉比路由",
        configName: "拉比路由",
        name: "路由配置 2",
        agentRoleId: "Rabi",
        rolesDir: path.join("data", "roles"),
        messageAdapterPolicies: {
          fennenote: {
            outputEnabled: true,
            supportedOutputs: ["text"]
          }
        }
      },
      {
        id: "其他路由",
        agentRoleId: "Other"
      }
    ],
    fenneNotePlaybackUrl: url
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.routeProfileId, "拉比路由");
  assert.equal(result.targetType, "voice_transcript");
  assert.equal(result.sentMessageId, "fenne-play-2");
  assert.ok(forwarded);
  assert.equal(forwarded.routeProfileId, "拉比路由");
  assert.equal(forwarded.messageId, "voice-log-1");
  assert.equal(forwarded.speakerName, "秋雨");
});

test("explicit WeCom group target sends through the WeCom SDK wrapper", async () => {
  const sent: Array<{ chatId: string; body: Record<string, unknown> }> = [];
  setWeComClientFactory(() => ({
    isConnected: true,
    connect() {},
    disconnect() {},
    on() { return undefined; },
    async sendMessage(chatId: string, body: Record<string, unknown>) {
      sent.push({ chatId, body });
      return { headers: { req_id: "wecom-send-1" }, body: { msgid: "wecom-msg-out-1" } };
    },
    async replyStream() { return { headers: { req_id: "unused" }, body: {} }; },
    async uploadMedia() { return { media_id: "media-1" }; },
    async sendMediaMessage() { return { headers: { req_id: "media-send-1" }, body: { msgid: "media-msg-1" } }; },
    async replyMedia() { return { headers: { req_id: "reply-media-1" }, body: {} }; }
  } as unknown as WeComClientLike));

  try {
    const result = await handleAgentReply({
      text: "hello wecom",
      adapterType: "wecom",
      targetType: "group",
      groupId: "wrCHATID"
    }, optionsWithRuntime({
      id: "wecom-route",
      pipeline: {
        outputAdapter: "codex",
        outputPipeline: "codex"
      },
      wecomBotId: "bot-id",
      wecomBotSecret: "bot-secret",
      messageAdapterPolicies: {
        wecom: {
          outputEnabled: true,
          supportedOutputs: ["text"]
        }
      }
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "sent");
    assert.equal(result.groupId, "wrCHATID");
    assert.equal(result.sentMessageId, "wecom-msg-out-1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "wrCHATID");
    assert.deepEqual(sent[0].body, {
      msgtype: "markdown",
      markdown: { content: "hello wecom" }
    });
  } finally {
    resetWeComClientFactory();
  }
});

test("WeCom source reply resolves chat id from wecom message log", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-wecom-"));
  const routeDir = path.join(rootDir, "data", "route", "wecom-route");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, "wecom-messages.jsonl"), `${JSON.stringify({
    time: 1,
    adapterType: "wecom",
    messageId: "wecom-source-1",
    reqId: "req-source-1",
    chatId: "wrSOURCECHAT",
    conversationId: "conversation-1",
    senderId: "zhangsan",
    rawMessage: "ping"
  })}\n`, "utf8");

  const sent: Array<{ chatId: string; body: Record<string, unknown> }> = [];
  setWeComClientFactory(() => ({
    isConnected: true,
    connect() {},
    disconnect() {},
    on() { return undefined; },
    async sendMessage(chatId: string, body: Record<string, unknown>) {
      sent.push({ chatId, body });
      return { headers: { req_id: "wecom-send-2" }, body: { msgid: "wecom-msg-out-2" } };
    },
    async replyStream() { return { headers: { req_id: "unused" }, body: {} }; },
    async uploadMedia() { return { media_id: "media-1" }; },
    async sendMediaMessage() { return { headers: { req_id: "media-send-1" }, body: { msgid: "media-msg-1" } }; },
    async replyMedia() { return { headers: { req_id: "reply-media-1" }, body: {} }; }
  } as unknown as WeComClientLike));

  try {
    const result = await handleAgentReply({
      text: "pong",
      messageId: "wecom-source-1"
    }, {
      rootDir,
      routeRoot: path.join(rootDir, "data", "route"),
      rolesRoot: path.join(rootDir, "data", "roles"),
      runtimes: [{
        id: "wecom-route",
        dataDir: path.join("data", "route", "wecom-route"),
        pipeline: {
          outputAdapter: "codex",
          outputPipeline: "codex"
        },
        wecomBotId: "bot-id",
        wecomBotSecret: "bot-secret",
        messageAdapterPolicies: {
          wecom: {
            outputEnabled: true,
            supportedOutputs: ["text"]
          }
        }
      }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "sent");
    assert.equal(result.groupId, "wrSOURCECHAT");
    assert.equal(result.userId, "zhangsan");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "wrSOURCECHAT");
  } finally {
    resetWeComClientFactory();
  }
});

test("WeCom output policy blocks disabled sending", async () => {
  const result = await handleAgentReply({
    text: "blocked",
    adapterType: "wecom",
    targetType: "group",
    groupId: "wrCHATID"
  }, optionsWithRuntime({
    id: "wecom-route",
    pipeline: {
      outputAdapter: "wecom",
      outputPipeline: "wecom"
    },
    wecomBotId: "bot-id",
    wecomBotSecret: "bot-secret",
    messageAdapterPolicies: {
      wecom: {
        outputEnabled: false,
        supportedOutputs: ["text"]
      }
    }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "WeCom message sending is disabled by this route policy.");
});

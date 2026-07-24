import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentReply, napcatGroupReplyMessage, type AgentReplyOptions } from "./outbox.js";
import { publishRabiLinkRelayMessage } from "./adapters/rabilinkRelayWorker.js";
import { resetWeComClientFactory, setWeComClientFactory, type WeComClientLike } from "./wecom.js";
import { recentMessageContextItems } from "./messageContextStore.js";

function optionsWithRuntime(runtime: AgentReplyOptions["runtimes"][number]): AgentReplyOptions {
  return {
    rootDir: process.cwd(),
    routeRoot: "data/route",
    rolesRoot: "data/roles",
    runtimes: [runtime]
  };
}

async function withJsonServer<T>(
  handler: (body: Record<string, unknown>, request: http.IncomingMessage) => Record<string, unknown> | void,
  run: (url: string) => Promise<T>
): Promise<T> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const data = handler(body, request) ?? { ok: true, id: "fenne-reply-1" };
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

async function withSpeechJsonServer<T>(
  handler: (body: Record<string, unknown>) => void,
  run: (url: string) => Promise<T>
): Promise<T> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      handler(raw ? JSON.parse(raw) as Record<string, unknown> : {});
      response.writeHead(200, {
        "content-type": "audio/wav",
        "x-rabispeech-provider": "local-tts",
        "x-rabispeech-model": "qwen3-tts-0.6b-base",
        "x-rabispeech-playback-job": "speech-play-1"
      });
      response.end(Buffer.from("RIFFtest"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Agent output keeps replies in the local Agent session without creating drafts", async () => {
  const result = await handleAgentReply({
    routeProfileId: "main",
    text: "keep this in the Agent session"
  }, optionsWithRuntime({
    id: "main",
    pipeline: {
      outputAdapter: "agent",
      outputPipeline: "agent"
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "Reply kept in the local Agent session.");
});

test("legacy Codex reply context normalizes to the local Agent output", async () => {
  const result = await handleAgentReply({
    routeProfileId: "main",
    text: "legacy local result",
    replyContext: {
      outputAdapter: "codex",
      outputPipeline: "codex"
    }
  }, optionsWithRuntime({
    id: "main",
    pipeline: {
      outputAdapter: "agent",
      outputPipeline: "agent"
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "Reply kept in the local Agent session.");
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

test("NapCat group reply helper binds text and segment messages to the source message", () => {
  assert.equal(
    napcatGroupReplyMessage("【问题】已接手。", "source-1", true),
    "[CQ:reply,id=source-1]【问题】已接手。"
  );
  assert.deepEqual(
    napcatGroupReplyMessage([{ type: "text", data: { text: "已接手。" } }], "source-2", true),
    [
      { type: "reply", data: { id: "source-2" } },
      { type: "text", data: { text: "已接手。" } }
    ]
  );
});

test("NapCat group reply helper respects opt-out and does not duplicate an existing reply", () => {
  assert.equal(napcatGroupReplyMessage("主动进度提醒", "source-1", false), "主动进度提醒");
  assert.equal(
    napcatGroupReplyMessage("[CQ:reply,id=source-1]【问题】继续跟进。", "source-1", true),
    "[CQ:reply,id=source-1]【问题】继续跟进。"
  );
  assert.deepEqual(
    napcatGroupReplyMessage([{ type: "reply", data: { id: "source-1" } }, { type: "text", data: { text: "继续跟进。" } }], "source-1", true),
    [{ type: "reply", data: { id: "source-1" } }, { type: "text", data: { text: "继续跟进。" } }]
  );
});

test("QQ group source reply sends a real NapCat reply segment", async () => {
  let sentBody: Record<string, unknown> | undefined;
  await withJsonServer((body) => {
    sentBody = body;
    return { status: "ok", retcode: 0, data: { message_id: "sent-1" } };
  }, async (url) => {
    const result = await handleAgentReply({
      text: "【工会入口】我先接手调查。",
      replyContext: {
        routeProfileId: "main",
        targetType: "group",
        groupId: "20002",
        messageId: "source-22",
        instanceId: "main-qq",
        adapterType: "napcat",
        outputAdapter: "qq",
        outputPipeline: "qq",
        replyToSource: true
      }
    }, optionsWithRuntime({
      id: "main",
      pipeline: { outputAdapter: "qq", outputPipeline: "qq", replyToSource: false },
      messageAdapterPolicies: {
        napcat: { outputEnabled: true, supportedOutputs: ["text"] }
      },
      napcatInstances: [{ id: "main-qq", httpUrl: url, accessToken: "", enabled: true }]
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "sent");
    assert.equal(result.sentMessageId, "sent-1");
  });

  assert.ok(sentBody);
  assert.equal(sentBody.group_id, 20002);
  assert.equal(sentBody.message, "[CQ:reply,id=source-22]【工会入口】我先接手调查。");
});

test("QQ group local files use upload_group_file and only read configured roots", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-file-"));
  const releaseDir = path.join(rootDir, "ReleasePkg");
  fs.mkdirSync(releaseDir, { recursive: true });
  const apkPath = path.join(releaseDir, "build.apk");
  fs.writeFileSync(apkPath, "test-apk", "utf8");
  const calls: Array<{ url?: string; body: Record<string, unknown> }> = [];

  await withJsonServer((body, request) => {
    calls.push({ url: request.url, body });
    if (request.url?.endsWith("/upload_group_file")) {
      return { status: "ok", retcode: 0, data: { file_id: "file-1", file_name: "build.apk" } };
    }
    return { status: "ok", retcode: 0, data: { message_id: "caption-1" } };
  }, async (url) => {
    const result = await handleAgentReply({
      payloadType: "file",
      filePath: apkPath,
      fileName: "build.apk",
      text: "【测试包】已上传。",
      replyContext: {
        routeProfileId: "main",
        targetType: "group",
        groupId: "20002",
        messageId: "source-22",
        instanceId: "main-qq",
        adapterType: "napcat",
        replyToSource: true
      }
    }, {
      rootDir,
      routeRoot: "data/route",
      rolesRoot: "data/roles",
      runtimes: [{
        id: "main",
        pipeline: { outputAdapter: "qq", outputPipeline: "qq", replyToSource: true },
        messageAdapterPolicies: {
          napcat: { outputEnabled: true, supportedOutputs: ["text", "file"], allowedFileRoots: [releaseDir] }
        },
        napcatInstances: [{ id: "main-qq", httpUrl: url, accessToken: "", enabled: true }]
      }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "sent");
    assert.equal(result.sentFileId, "file-1");
    assert.equal(result.sentFileName, "build.apk");
    assert.equal(result.sentMessageId, "caption-1");
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].url?.endsWith("/upload_group_file"));
  assert.deepEqual(calls[0].body, { group_id: 20002, file: apkPath, name: "build.apk" });
  assert.ok(calls[1].url?.endsWith("/send_group_msg"));
  assert.equal(calls[1].body.message, "[CQ:reply,id=source-22]【测试包】已上传。");
});

test("QQ group local file upload is blocked outside allowedFileRoots", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-file-blocked-"));
  const allowedDir = path.join(rootDir, "allowed");
  fs.mkdirSync(allowedDir, { recursive: true });
  const secretPath = path.join(rootDir, "secret.txt");
  fs.writeFileSync(secretPath, "do-not-send", "utf8");

  const result = await handleAgentReply({
    payloadType: "file",
    filePath: secretPath,
    targetType: "group",
    groupId: "20002",
    routeProfileId: "main"
  }, {
    rootDir,
    routeRoot: "data/route",
    rolesRoot: "data/roles",
    runtimes: [{
      id: "main",
      pipeline: { outputAdapter: "qq", outputPipeline: "qq" },
      messageAdapterPolicies: {
        napcat: { outputEnabled: true, supportedOutputs: ["file"], allowedFileRoots: [allowedDir] }
      },
      napcatInstances: [{ id: "main-qq", httpUrl: "http://127.0.0.1:1", accessToken: "", enabled: true }]
    }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /outside the configured allowedFileRoots/);
});

test("explicit group target can proactively use NapCat even when pipeline stays in the Agent session", async () => {
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
          outputAdapter: "agent",
          outputPipeline: "agent",
          replyToSource: false
        },
        messageAdapterPolicies: {
          napcat: ({
            outputEnabled: true,
            outputMode: "draft",
            supportedOutputs: ["text"],
            allowedGroups: ["10001"],
            disabledPipelines: ["agent"]
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

test("source reply resolves runtime route from message log and bypasses local Agent output", async () => {
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
      outputAdapter: "agent",
      outputPipeline: "agent",
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
          outputAdapter: "agent",
          outputPipeline: "agent",
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
            outputAdapter: "agent",
            outputPipeline: "agent"
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

test("RabiSpeech message endpoint binds TTS voice to the persona while preserving legacy fallbacks", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-rabispeech-"));
  let forwarded: Record<string, unknown> | undefined;
  const result = await withSpeechJsonServer((body) => {
    forwarded = body;
  }, (url) => handleAgentReply({
    text: "勇者，现在最短时间是十七点四十分。",
    replyContext: {
      runtimeRouteId: "speech-route",
      routeProfileId: "speech-route",
      routeKind: "voice_transcript",
      targetType: "voice_transcript",
      messageId: "speech-message-1",
      adapterType: "speech",
      sessionId: "speech-session-1",
      characterTtsDialogue: true,
      outputAdapter: "tts",
      outputPipeline: "rabispeech",
      replyToSource: false
    }
  }, {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    speechServiceUrl: url,
    runtimes: [{
      id: "speech-route",
      agentRoleId: "Ilias",
      pipelinePreset: "qq_chat",
      pipeline: {
        inputAdapter: "speech",
        outputAdapter: "agent",
        outputPipeline: "agent",
        ttsPlay: false
      },
      routeVariables: {
        speechTtsModel: "local-tts/qwen3-tts-0.6b-base",
        speechVoice: "legacy-route-voice",
        speechLanguage: "zh",
        speechSpeed: "1",
        speechInstructions: "温柔而庄重",
        speechAutoPlay: "true"
      },
      messageAdapterPolicies: {
        speech: {
          outputEnabled: true,
          supportedOutputs: ["text"]
        }
      }
    }]
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.reason, "Queued in the RabiSpeech host-wide playback queue.");
  assert.equal(result.sentMessageId, "speech-play-1");
  assert.ok(forwarded);
  assert.equal(forwarded.model, "local-tts/qwen3-tts-0.6b-base");
  assert.equal(forwarded.voice, "Ilias");
  assert.equal(forwarded.language, "zh");
  assert.equal(forwarded.instructions, "温柔而庄重");
  assert.equal(forwarded.play, true);
  assert.equal(forwarded.session_id, "speech-session-1");
  assert.equal(forwarded.route_id, "speech-route");
  const ttsContext = recentMessageContextItems([path.join(rootDir, "data", "roles", "Ilias")], {
    limit: 10,
    adapter: "speech",
    conversationKey: "speech:gateway:speech-route:session:speech-session-1"
  });
  assert.deepEqual(ttsContext.map(item => [item.direction, item.kind, item.text, item.sessionId]), [[
    "outbound",
    "tts",
    "勇者，现在最短时间是十七点四十分。",
    "speech-session-1"
  ]]);
});

test("successful QQ replies write the full outbound body to persona conversation context", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-context-"));
  const fullText = `完整回复-${"内容".repeat(300)}`;
  await withJsonServer(() => ({ status: "ok", retcode: 0, data: { message_id: "qq-out-full-1" } }), async (url) => {
    const result = await handleAgentReply({
      text: fullText,
      replyContext: {
        runtimeRouteId: "qq-route",
        routeProfileId: "qq-route",
        targetType: "group",
        groupId: "10001",
        messageId: "qq-in-1",
        instanceId: "qq-main",
        adapterType: "napcat",
        logicalAdapter: "napcat",
        transport: "napcat",
        conversationKey: "napcat:gateway:qq-route:instance:qq-main:group:10001",
        outputAdapter: "qq",
        replyToSource: true
      }
    }, {
      rootDir,
      routeRoot: path.join(rootDir, "data", "route"),
      rolesRoot: path.join(rootDir, "data", "roles"),
      runtimes: [{
        id: "qq-route",
        agentRoleId: "XinghaiBuilder",
        pipeline: { inputAdapter: "napcat", outputAdapter: "qq", outputPipeline: "qq", replyToSource: true },
        messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["text"] } },
        napcatInstances: [{ id: "qq-main", httpUrl: url, accessToken: "", enabled: true }]
      }]
    });
    assert.equal(result.ok, true);
  });

  const items = recentMessageContextItems([path.join(rootDir, "data", "roles", "XinghaiBuilder")], {
    limit: 10,
    adapter: "napcat",
    conversationKey: "napcat:gateway:qq-route:instance:qq-main:group:10001"
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].direction, "outbound");
  assert.equal(items[0].text, fullText);
  assert.equal(items[0].messageId, "qq-out-full-1");
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
        outputAdapter: "agent",
        outputPipeline: "agent"
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
          outputAdapter: "agent",
          outputPipeline: "agent"
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

test("RabiLink source reply is gated by route policy and queued for the Relay worker", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-rabilink-"));
  let deliveredBody: Record<string, unknown> = {};
  let deliveredToken = "";
  await withJsonServer((body, request) => {
    deliveredBody = body;
    deliveredToken = String(request.headers["x-rabilink-token"] || "");
    return { ok: true, status: "queued", messages: [{ id: "out-reply-1", proactive: false }] };
  }, async (url) => {
    const result = await handleAgentReply({
      text: "RabiLink 回传测试。",
      replyContext: {
        runtimeRouteId: "RabiLink",
        gatewayId: "RabiLink",
        routeProfileId: "RabiLink",
        routeKind: "rabilink",
        targetType: "rabilink",
        messageId: "rabilink-source-1",
        adapterType: "rabilink",
        sourceDeviceId: "phone-one",
        sourceDeviceKind: "mobile",
        outputAdapter: "agent",
        outputPipeline: "agent",
        replyToSource: false
      }
    }, {
      rootDir,
      routeRoot: path.join(rootDir, "data", "route"),
      rolesRoot: path.join(rootDir, "data", "roles"),
      runtimes: [{
        id: "RabiLink",
        rabiLinkRelay: {
          enabled: true,
          url: new URL(url).origin,
          token: "test-relay-token",
          deviceId: "pc-test"
        },
        messageAdapterPolicies: {
          rabilink: {
            outputEnabled: true,
            supportedOutputs: ["text"]
          }
        }
      }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "sent");
    assert.equal(result.reason, "Queued in the RabiLink outbound message stream.");
    assert.equal(result.targetType, "rabilink");
    assert.equal(deliveredBody.text, "RabiLink 回传测试。");
    assert.equal(deliveredBody.taskId, "rabilink-source-1");
    assert.equal(typeof deliveredBody.deliveryId, "string");
    assert.ok(String(deliveredBody.deliveryId).length > 0);
    assert.equal(deliveredBody.proactive, false);
    assert.equal(deliveredBody.final, true);
    assert.equal(deliveredBody.deviceId, "pc-test");
    assert.deepEqual(deliveredBody.targetDeviceIds, ["phone-one"]);
    assert.equal(deliveredToken, "test-relay-token");
    const replyLog = path.join(rootDir, "data", "route", "RabiLink", "rabilink-replies.jsonl");
    const rows = fs.readFileSync(replyLog, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "RabiLink 回传测试。");
    assert.equal(rows[0].adapterType, "rabilink");
    assert.equal(rows[0].final, true);
    const conversationRows = fs.readFileSync(path.join(rootDir, "data", "route", "RabiLink", "rabilink-conversation.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(conversationRows.length, 1);
    assert.equal(conversationRows[0].direction, "agent_to_user");
    assert.equal(conversationRows[0].taskId, "rabilink-source-1");
    assert.equal(conversationRows[0].messageId, "out-reply-1");
  });
});

test("proactive RabiLink output enters the continuous Relay stream without a source task", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-rabilink-proactive-"));
  let deliveredBody: Record<string, unknown> = {};
  let deliveredToken = "";
  await withJsonServer((body, request) => {
    deliveredBody = body;
    deliveredToken = String(request.headers["x-rabilink-token"] || "");
    return { ok: true, status: "queued", messages: [{ id: "out-1", proactive: true }] };
  }, async (url) => {
      const result = await handleAgentReply({
        routeProfileId: "RabiLink",
        targetType: "rabilink",
        proactive: true,
        source: "scheduler-test",
        targetDeviceKinds: ["glasses"],
        presentation: ["text", "tts"],
        priority: "urgent",
        text: "该休息一下了。"
      }, {
        rootDir,
        routeRoot: path.join(rootDir, "data", "route"),
        rolesRoot: path.join(rootDir, "data", "roles"),
        runtimes: [{
          id: "RabiLink",
          rabiLinkRelay: {
            enabled: true,
            url: new URL(url).origin,
            token: "test-relay-token",
            deviceId: "pc-test"
          },
          messageAdapterPolicies: {
            rabilink: {
              outputEnabled: true,
              supportedOutputs: ["text"]
            }
          }
        }]
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "sent");
      assert.equal(result.reason, "Queued in the RabiLink continuous message stream.");
      assert.equal(deliveredBody.text, "该休息一下了。");
      assert.equal(deliveredBody.source, "scheduler-test");
      assert.equal(deliveredBody.deviceId, "pc-test");
      assert.equal(deliveredBody.taskId, "");
      assert.equal(typeof deliveredBody.deliveryId, "string");
      assert.ok(String(deliveredBody.deliveryId).length > 0);
      assert.equal(deliveredBody.proactive, true);
      assert.equal(deliveredBody.final, true);
      assert.deepEqual(deliveredBody.targetDeviceKinds, ["glasses"]);
      assert.deepEqual(deliveredBody.presentation, ["text", "tts"]);
      assert.equal(deliveredBody.priority, "urgent");
      assert.equal(deliveredToken, "test-relay-token");
      assert.equal(result.messageId, undefined);
      const conversationRows = fs.readFileSync(path.join(rootDir, "data", "route", "RabiLink", "rabilink-conversation.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(conversationRows.length, 1);
      assert.equal(conversationRows[0].direction, "agent_to_user");
      assert.equal(conversationRows[0].proactive, true);
      assert.equal(conversationRows[0].text, "该休息一下了。");
      assert.deepEqual(conversationRows[0].targetDeviceKinds, ["glasses"]);
      assert.deepEqual(conversationRows[0].presentation, ["text", "tts"]);
      assert.equal(conversationRows[0].priority, "urgent");
  });
});

test("RabiLink mobile endpoint uploads and delivers an Agent file attachment", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-outbox-rabilink-file-"));
  const releaseDir = path.join(rootDir, "release"); fs.mkdirSync(releaseDir, { recursive: true });
  const filePath = path.join(releaseDir, "report.pdf"); fs.writeFileSync(filePath, "pdf-test");
  let deliveredBody: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.url?.startsWith("/api/rabilink/devices/media")) {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ attachment: { id: "media-1", kind: "file", fileName: "report.pdf", contentType: "application/octet-stream", size: 8, downloadPath: "/api/rabilink/devices/media/media-1?fileName=report.pdf" } }));
        return;
      }
      deliveredBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, messages: [{ id: "out-file-1" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const result = await handleAgentReply({
      payloadType: "file", filePath, fileName: "report.pdf", text: "报告在附件里。",
      routeProfileId: "RabiLink", targetType: "rabilink", proactive: true
    }, {
      rootDir, routeRoot: path.join(rootDir, "data", "route"), rolesRoot: path.join(rootDir, "data", "roles"),
      runtimes: [{ id: "RabiLink", rabiLinkRelay: { enabled: true, url: `http://127.0.0.1:${address.port}`, token: "test-token", deviceId: "pc-test" },
        messageAdapterPolicies: { rabilink: { outputEnabled: true, supportedOutputs: ["text", "image", "voice", "file"], allowedFileRoots: [releaseDir] } } }]
    });
    assert.equal(result.ok, true);
    const attachments = deliveredBody.attachments as Array<Record<string, unknown>>;
    assert.equal(attachments.length, 1); assert.equal(attachments[0].fileName, "report.pdf");
    assert.equal(deliveredBody.routeProfileId, "RabiLink");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("RabiLink outbound publisher retries with one stable delivery id", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      if (bodies.length === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "queued", deduplicated: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await publishRabiLinkRelayMessage("主动消息可靠投递测试。", {
      proactive: true,
      relay: {
        enabled: true,
        url: `http://127.0.0.1:${address.port}`,
        token: "test-token",
        deviceId: "pc-test",
        deviceGuid: "guid-test"
      }
    });
    assert.equal(result.ok, true);
    assert.equal(bodies.length, 2);
    assert.equal(typeof bodies[0].deliveryId, "string");
    assert.ok(String(bodies[0].deliveryId).length > 0);
    assert.equal(bodies[1].deliveryId, bodies[0].deliveryId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("RabiLink source reply respects disabled route output policy", async () => {
  const result = await handleAgentReply({
    text: "不应发送。",
    replyContext: {
      runtimeRouteId: "RabiLink",
      routeProfileId: "RabiLink",
      targetType: "voice_transcript",
      adapterType: "rabilink"
    }
  }, optionsWithRuntime({
    id: "RabiLink",
    messageAdapterPolicies: {
      rabilink: {
        outputEnabled: false,
        supportedOutputs: ["text"]
      }
    }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "RabiLink message sending is disabled by this route policy.");
});

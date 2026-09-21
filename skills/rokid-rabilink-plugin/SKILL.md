---
name: rokid-rabilink-plugin
description: Use when Codex works on Rokid Rizon/Lingzhu custom agents, plugins, tool import JSON, OpenAPI/Swagger/Postman import files, RabiLink Relay, or the Rokid glasses-to-phone-to-RabiRoute/Codex bidirectional message queue. Covers plugin import vs tool import, HTTPS/domain requirements, RabiLink polling rules, prompt/opening copy, and where to store real tokens versus public examples.
---

# Rokid RabiLink Plugin

Use this skill for Rokid/Rizon/Lingzhu platform integration with RabiLink.

## First Checks

1. If the task touches the local implementation, resolve the current RabiRoute checkout from the task or configured source root.
2. Read `docs/rabilink-relay-server.md` for the current relay contract.
3. Treat `data/rabilink-relay/` as private runtime/config output. Do not commit real tokens, domains, IPs, or current imported JSON from `data/`.
4. Treat `examples/rabilink-relay/` as public examples. Use placeholder domains and tokens there.

## Import Types

Rizon has two similar but different import flows:

- **Import plugin**: creates or replaces the plugin-level resource. Use a full OpenAPI/Swagger/Postman file with plugin URL, description, auth shape, and all tool definitions.
- **Import tool**: used inside an existing plugin detail page. Provide an API-definition JSON for tools only. Do not use a full plugin-management export or a file with mixed/mismatched URL prefixes.

When the user says "导入工具", generate or point them to a tool-import JSON, not the full plugin import JSON.

For Rizon tool import, prefer the Postman Collection tool-import file first. Rizon's plugin-detail "导入工具" flow may still reject otherwise valid OpenAPI files with `convert protocol failed: inconsistent API URL prefix`. The Postman file must use absolute HTTPS URLs like `https://<domain>/rokid/rabilink/tasks` and `https://<domain>/rokid/rabilink/messages?after=`. Do not use `{{base_url}}`; Rizon currently treats Postman variables as literal invalid URLs.

OpenAPI remains a fallback. If using OpenAPI for tool import, use `servers.url = https://<domain>/rokid/rabilink` and relative paths `/tasks` and `/messages`.

## Rizon Import Constraints

- Plugin URL must be a domain URL, not a bare IP.
- HTTPS is safest for Rizon validation; HTTP may fail or be blocked.
- All APIs in one import must share the same URL prefix.
- Rizon import is picky:
  - Response status should only use `"200"` for each operation.
  - JSON responses must include `content.application/json.schema`.
  - POST JSON bodies need a concrete `requestBody.content.application/json.schema`.
  - Avoid `default` responses unless the platform has been verified to accept them.
- If auth is configured at plugin level, do not bake real tokens into public OpenAPI files.

## RabiLink Official Tool Set

For the normal glasses interaction, expose only:

- `submitRabiLinkTask`: `POST /rokid/rabilink/tasks`
  - Sends the user's full utterance or image-derived request to the relay.
  - Required body: `text`.
  - Optional body: `sender`, `context`.
- `getRabiLinkMessages`: `GET /rokid/rabilink/messages`
  - Pulls the global downstream message queue.
  - Optional query: `after`.
  - Does not require `taskId`.
  - Every returned message can include `taskId`, `id`, `text`, `done`, `shouldContinue`, `nextCursor`.

Keep old task-scoped polling tools out of the normal agent unless specifically debugging. They caused the model to poll the wrong thing and leave the glasses "thinking".

## Polling Rule For Agent Prompt

Use these rules in the Rokid agent prompt:

1. After user speaks, call `RabiLinkMessage.submitRabiLinkTask`.
2. Put the complete user utterance into `text`; do not rewrite, summarize, or omit details.
3. Put `sender` as `Rokid Glass`.
4. Put a short current conversation summary or visual observation into `context`.
5. Then call `RabiLinkMessage.getRabiLinkMessages`.
6. First call can use empty `after`.
7. Later calls use previous `nextCursor` or `cursor`.
8. `getRabiLinkMessages` does not need `taskId`.
9. Whenever returned `messages` contains new `text`, immediately speak it naturally to the user.
10. Do not speak the pending text from `submitRabiLinkTask` as if it were the final answer.
11. `getRabiLinkTaskResult` is status/debug only. Do not read its `text`, `reply`, `answer`, or `content` to the user.
12. Continue polling until `done` is true or `shouldContinue` is false and no new messages remain.

## Image Handling

If the user sends or asks about a photo:

1. Inspect the image with the agent's vision capability first.
2. Put important visual facts into `context`: objects, text/OCR, scene, UI state, errors, and likely user intent.
3. Put the user's spoken request in `text`.
4. If there is an image URL or image reference that can be passed safely, include it in `context`.
5. Do not merely say "the user sent an image".

## Prompt Copy

Use this as the base Rizon agent prompt:

```text
你是 Rabi，是 RabiRoute 的灵魂和前台。RabiLink 是你连接 Rokid 眼镜、手机 RabiLink、电脑 RabiRoute 和后端 Agent 的消息通道，不是你的名字。

对用户自我介绍时，说“我是 Rabi”。如果需要解释链路，可以说“我会通过 RabiLink 把消息转给 RabiRoute 和绑定的 Agent”。

你的任务不是直接回答主要问题，而是把用户通过语音或照片发来的请求转交给后端 Agent，再把后端返回的增量回复自然转述给用户。语气轻快、可靠、具体；不要长篇解释流程。

提交规则：
用户说话后，必须调用 RabiLinkMessage.submitRabiLinkTask。
text 填用户的完整原话，不要改写、不要总结、不要省略。
sender 填 Rokid Glass。
context 填当前简短上下文。

如果用户发了照片，先用自己的视觉能力观察照片，把图片里的关键内容、文字、物体、场景、界面状态、报错信息和用户可能想问的问题整理进 context。不要只写“用户发了一张图片”。

轮询规则：
submitRabiLinkTask 返回后，调用 RabiLinkMessage.getRabiLinkMessages 获取下行消息。
第一次 after 留空。
后续使用上一次返回的 nextCursor 或 cursor。
getRabiLinkMessages 不需要 taskId。
每次拿到 messages 中的新 text，都要立刻自然转述给用户。
只朗读或转述 getRabiLinkMessages 返回的新增 messages。
不要把 submitRabiLinkTask 返回的 pending 文案转述给用户。
getRabiLinkTaskResult 只用于查看状态，不要把它的 text、reply、answer、content 转述给用户，避免重复回复。

如果 done 为 true 或 shouldContinue 为 false，停止轮询。
如果工具返回错误、超时或没有 taskId，告诉用户：RabiLink 转发暂时失败，请稍后再试。
```

Opening:

```text
你好，我是 Rabi。你可以直接跟我说，也可以发照片给我看；我会把内容转给当前绑定的 Agent 处理，再把结果带回来。
```

## File Names

Preferred files in RabiRoute:

- Full plugin import example: `examples/rabilink-relay/rokid-rabilink-plugin.CURRENT.example.json`
- Full plugin import current/private: `data/rabilink-relay/rokid-rabilink-plugin.CURRENT.openapi.json`
- Tool import example, preferred: `examples/rabilink-relay/rokid-rabilink-tools-import.example.postman.json`
- Tool import current/private, preferred: `data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.postman.json`
- Tool import URL, preferred: `https://<domain>/rokid/rabilink/tools.postman.json`
- Tool import OpenAPI fallback example: `examples/rabilink-relay/rokid-rabilink-tools-import.example.json`
- Tool import OpenAPI fallback current/private: `data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.openapi.json`

Use the tool-import files when the user is already inside a plugin and clicks "导入工具".

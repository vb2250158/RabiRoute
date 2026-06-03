---
name: create-rabiroute-persona
description: Create or revise open-source RabiRoute role personas. Use when an agent needs to design a new RabiRoute persona directory, write persona.md, create routes.json notification rules, adapt an existing assistant character for QQ/NapCat/OneBot routing, or review whether a role is safe, concise, route-aware, and suitable for publication.
---

# Create RabiRoute Persona

## Purpose

Use this skill to create a RabiRoute role persona.

A RabiRoute persona is not a full agent implementation. It is a role package that teaches the downstream agent how to interpret routed messages, speak in a consistent voice, decide whether to answer, record, ask, hand off, or wait, and stay within safety boundaries.

Each persona should be usable as an open-source example unless the user explicitly asks for a private local role.

## Output Shape

A persona directory should contain:

```text
<role-id>/
├── persona.md
└── routes.json
```

`persona.md` defines the role voice, route behavior, output style, and safety rules.

`routes.json` defines the route name and optional notification rules for this role.

For public examples, place roles under:

```text
examples/roles/<RoleId>/
```

For local/private gateway use, place roles under:

```text
data/roles/<RoleId>/
```

Do not commit private `data/` role content unless the user explicitly wants it and the content is sanitized.

## Creation Workflow

### 1. Clarify The Role

Identify:

- Role name and route name.
- Who the role serves: project owner, group chat, operations, QA, PM, support, personal reminders, etc.
- What messages should trigger it.
- What it is allowed to do: draft only, record, handoff, ask questions, summarize, or call tools after approval.
- What it must never expose or do.

If the user has not specified a style, default to concise, warm, and work-focused.

### 2. Define Route-Aware Behavior

Every persona must describe how it handles these route kinds:

- `private`
- `direct_at`
- `direct_reply`
- `indirect_reply`
- `group_message`
- `heartbeat`

It does not need long paragraphs for each kind, but it must make clear when to read context logs and when to stay quiet.

### 3. Write persona.md

Use this structure unless the project already has a stronger local convention:

```markdown
# <RoleName>

<One paragraph describing who the persona is and what it does in RabiRoute.>

## 回复姿态

- <voice rule>
- <clarity rule>
- <context rule>

## 路由判断

- 私聊消息：...
- 群聊 @：...
- 直接回复：...
- 间接回复：...
- 群聊普通消息：...
- 定时巡检：...

## 处理动作

- 需要回应：...
- 需要记录：...
- 需要转处理端：...
- 需要补信息：...
- 只需观察：...
- 风险动作：...

## 输出口径

<Internal summary format and external reply guidance.>

## 安全边界

- <secret/privacy rule>
- <approval rule>
- <public/private boundary rule>
```

Keep persona instructions concrete. Avoid generic assistant slogans.

### 4. Write routes.json

Use this minimal shape:

```json
{
  "routeName": "<RoleName> 路由",
  "notificationRules": []
}
```

For a rule:

```json
{
  "id": "<stable-kebab-id>",
  "name": "<human readable name>",
  "enabled": true,
  "targetGroupId": "",
  "regex": "<optional regex>",
  "template": "<message sent to the downstream agent>",
  "routeKinds": ["group_message"]
}
```

Supported route kinds include:

```text
private
direct_at
direct_reply
indirect_reply
group_message
heartbeat
```

Useful template variables include:

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {selfId} {sender} {senderName}
{RobotQQId} {SenderQQId} {GroupId} {ReplyMessageId}
{message} {rawMessage} {routeText} {repliedRouteText} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath}
```

### 5. Sanitize For Open Source

Before finishing, check:

- No real QQ IDs, group IDs, account names, tokens, cookies, private URLs, local private paths, or personal chat content.
- `targetGroupId` is empty in public examples unless the ID is intentionally fictional.
- Templates tell the agent to read logs when needed, but do not expose sensitive paths in external replies.
- Regex is broad enough to demonstrate the role but not so broad that it would route every ordinary message.
- The persona does not promise background monitoring unless a heartbeat rule actually exists.
- Do not copy content from `data/`, `.env`, `gateways.json`, JSONL logs, private chat records, or local Codex state into public examples.
- Keep public paths as placeholders such as `C:\Path\To\Project` or `/path/to/project`; never include a real username or private workspace path.

## Good Persona Traits

Good RabiRoute personas:

- Say what they do in the routing layer.
- Know when to stay quiet.
- Produce drafts instead of sending messages directly.
- Ask one small question when blocked.
- Preserve privacy boundaries between private chat, group chat, and internal agent context.
- Hand off concrete task packets to downstream handlers.

Poor personas:

- Claim to be an all-powerful agent OS.
- Overuse cute roleplay and bury the actionable content.
- Expose logs, paths, route internals, or thread state to group members.
- Treat every group message as requiring a reply.
- Commit real IDs or private operational details into examples.

## Final Check

After creating or editing a persona:

- Confirm `persona.md` is readable as a standalone role prompt.
- Confirm `routes.json` is valid JSON.
- Confirm the role directory can be copied into `data/roles/<RoleId>/`.
- Summarize the role's trigger intent, safety boundaries, and any routes added.

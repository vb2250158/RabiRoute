<!-- docs-language-switch -->
<div align="center">
English | <a href="./grok-bot-agent-adapter.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Grok Bot Agent adapter

For integration developers and local operators. `grokBot` handles messages selected by a Route: RabiRoute delivers to an existing Grok Bot service, the service answers in its own session, and the result returns through Rabi APIs.

**Status: experimental implementation.** The native cloud owner was checked against the installed Grok Bot 0.70.2 service contract. A real, read-only Agent-list request succeeded using the current login. Bidirectional delivery, session reuse, timeout recovery and the deployed runtime version require separate acceptance evidence. Adapter maturity remains `experimental`.

## Owner and transport

The existing Grok cloud service owns and executes its sessions. RabiRoute uses that owner's native HTTP API to read and deliver to an exact session. It does not create another Grok Runtime or declare Grok sessions as Codex Desktop tasks.

Grok's routine webhook starts a routine run and cannot continue the original session. It therefore does not implement exact-session delivery for this adapter. Integration uses the existing login and session service rather than substituting a newly created routine or webhook key for session identity.

The native API depends on the installed service contract. Recheck discovery, authentication, session reads and delivery responses after an upgrade. Accounts, Bot identifiers, session IDs, protected login data and message bodies remain in local runtime data; public examples use placeholders.

## Configuration and discovery

Start and sign in through Grok Bot first. Windows discovery reads only the active account's protected profile and uses the original Windows user to decrypt it. Credentials remain in client memory for requests to the original service; they are not written back to the profile or exposed in logs or scan results.

| Route field | Environment variable | Purpose |
| --- | --- | --- |
| `grokBotAgentId` | `GROK_BOT_AGENT_ID` | Bot owner ID belonging to the current account |
| `grokBotSessionId` | `GROK_BOT_SESSION_ID` | Complete session ID returned by discovery |
| `grokBotSessionName` | `GROK_BOT_SESSION_NAME` | Display name, not an identity |

The service address is resolved automatically from the native integration contract (`https://api2.cursor.sh/`); it is no longer editable. The profile directory is discovered for the current Windows user and displayed read-only. Retired Route/query/environment connection overrides are ignored, and Route normalization removes the old address and profile fields. This is the product backend, separate from Rabi Manager. Discover Manager from the current Host/READY identity and verify `/meta`; do not fix its port.

In Route Agent settings, choose **Primary persona Bot**. RabiRoute binds that Bot's discovered default main session and selects Grok Bot as the primary Agent. No session ID or directory needs to be entered. The desktop must remain running; a stale login file alone is insufficient. Opening settings performs one automatic discovery; after starting or signing in later, click **Refresh Grok Bot**. Discovery does not write login files or refresh credentials on behalf of Grok Bot.

Explicitly scan existing Bots and sessions:

```http
GET <managerBaseUrl>/api/scan/agents?agentAdapter=grokBot
GET <managerBaseUrl>/api/scan/agents/grokBot
GET <managerBaseUrl>/api/scan/agents?agentAdapter=grokBot&grokBotAgentId=<URL-encoded owner ID>&grokBotLimit=100&grokBotOffset=0&grokBotQuery=<URL-encoded Bot name>
```

Select the original session from `agents.grokBot.sessions` and retain `id` and `name`. Continue with `sessionPage.hasMore/nextOffset` and the `grokBotOffset` parameter, not `cursor`. Discovery creates no Bot, session or routine. If the list is empty, check the original account and existing sessions in Grok Bot.

An ordinary private session's canonical ID is `grokBot:` followed by `base64url(JSON([ownerAgentId,nativeSessionId]))`. The native default main session uses `base64url(JSON([ownerAgentId,{"defaultMain":true}]))` with the same `grokBot:` prefix. Default-main addresses require real roster verification. Temporal private sessions also require chat-history verification; ROOM addresses are established directly by the roster, not by a private session. Public `sourceThreadId` and `messageSource.sessionId` must always contain the complete, nonempty ID. Copy the value returned by discovery instead of encoding, constructing or guessing it. Route `grokBotAgentId` must match the owner inside that ID.

A saved group identity address may instead contain `base64url(JSON([senderAgentId,groupId]))` with the same prefix and no `defaultMain` marker. This is a **roster-backed group address**, not a private session returned by `listSessions(sender)`. With `deliveryType=group`, the native roster must prove that `groupId` is a ROOM, that `senderAgentId` is a real AGENT and room member, and that it matches the explicit `fromAgentId`. Delivery uses `SendGrokBotAgentMessage` with native `toAgentId=groupId` and `fromAgentId=senderAgentId`. Journal receipts retain the original sender/group tuple; reconciliation maps it to the room's native main address and queries the same messageId. Failures never send to the sender's private chat or rewrite the binding to a default session.

List requests may include the saved `threadId`. After roster membership verification, the room row retains that complete ID. Its `nativeAgentId/nativeAgentName` still describe the room's real ID/name, and `kind/memberAgentIds` retain the native values. Listing must not rewrite the address into a private or default-main session. The discovered room-owner/defaultMain form remains compatible. Protocol unit tests and real group-delivery acceptance are recorded separately.

Route configuration fragment:

```json
{
  "agentAdapter": "grokBot",
  "grokBotAgentId": "<owner ID returned by scan>",
  "grokBotSessionId": "<complete grokBot session ID returned by scan>",
  "grokBotSessionName": "Integration Bot session"
}
```

## Capabilities and operations

| Metadata | Current value |
| --- | --- |
| `type` | `grokBot` |
| `maturity` | `experimental` |
| `transport` | `{ "protocol": "http", "mode": "grok-bot-owner" }` |
| `host` | `{ "name": "Grok Bot cloud owner", "required": true }` |
| `capabilities.managedTasks` | Only `agentThreads=true` |

Existing sessions support discovery, reads and exact delivery. The current native API has no create, rename or open operation; those requests fail explicitly and an actual existing session is required. Plan-assistant sessions, message-processing pools, memory consolidation, Hooks and automatic receipt recovery are not declared capabilities.

The endpoint uses `kind=service`. Connecting an owner or reading status/authentication does not traverse all sessions; only explicit scans or exact-session operations read the relevant list. A changed Bot owner or account requires the original session to be verified again. A same-name object or new account cannot inherit an old request.

## Sources and replies

Top-level `agentAdapter` and `threadId` select the recipient. `messageSource.agentAdapter`, `messageSource.sessionId` and `sourceThreadId` identify the actual sender. A Bot request uses `type=agent`, `agentAdapter=grokBot` and a source session confirmed by the Bot owner.

Session IDs are complete opaque identifiers. Preserve the owner's value without shortening it, inferring a provider from its shape, borrowing the recipient's Codex ID, or replacing identity with a name. When authenticated request context supplies a source identity, the body must match it.

The two reply paths use existing Rabi APIs:

| Original message | Reply API | Required context |
| --- | --- | --- |
| QQ → Grok Bot | `POST /api/agent/send`, `channel=napcat` | Original Route, NapCat instance, group/DM destination, quoted message and stable delivery ID |
| Codex → Grok Bot | `POST /api/agent/threads`, `action=send` | Original Codex task, the Bot's own source session, and `inReplyToRequestId/result/nextAction` for a formal reply |

`/api/agent/send` sends to message channels and does not provide `channel=grokBot`. See [Rabi Agent interfaces](rabi-agent-interfaces_en.md) for complete requests, formal replies and source failures.

Exact Codex-to-Bot delivery:

```json
{
  "action": "send",
  "agentAdapter": "grokBot",
  "threadId": "<complete target Bot session ID returned by scan>",
  "deliveryId": "codex-to-bot-check-001",
  "prompt": "Confirm receipt of this integration check.",
  "sourceThreadId": "<complete real source Codex session ID>",
  "sourceAgentType": "agent",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "<complete real source Codex session ID>",
    "sessionName": "Integration check task"
  },
  "responsePolicy": "none"
}
```

For a formal Bot reply, choose `responsePolicy=required` and supply `responseInstruction`. The reply reverses the original endpoints, uses the complete Bot ID from discovery as its source, and returns `inReplyToRequestId/result/nextAction`. Continue through the same authenticated Rabi connection; message-body claims do not create another authentication layer.

## Session reuse and unknown outcomes

### Private chats, groups and sender identities in rule actions

Status: source implementation. The installed application needs a compatible hot patch and runtime acceptance first. Do not bypass compatibility checks when the deployed baseline lacks support. If the user explicitly requests configuration-file migration first, report file readback and runtime activation separately.

An identity-based group address may also use `grokBot:` + `base64url(JSON([senderBotId,groupId]))`. Validation uses the native group roster and membership, not a claimed private session of that Bot. Sending uses the group as `toAgentId` and the Bot as `fromAgentId`; reconciliation addresses the same group. The UI preserves the complete Manager-verified address rather than deriving it from display names.

Choose a custom target, then configure: Grok Bot Agent → conversation type (private / group) → destination session or group → send mode (direct / specified identity) → identity. Groups and identities come from the current account's native roster; names do not replace IDs.

The common service delivery bridge must also verify the group address and membership and freeze the send mode and identity in each delivery's execution options and hash. Discovery or a standalone send helper is not sufficient. If a valid native group address fails with `GROK_BOT_SESSION_NOT_FOUND` at the public endpoint, check whether the bridge still treats the group ID as a private session belonging to the sender Bot. Do not fall back to the default private chat or compensate with a scheduled Bot relay.

`action.target` retains `kind=session`, `agentTargetId`, `agentAdapter=grokBot`, the complete `sessionId`, `sessionName` and an empty `workspace`. It adds `deliveryType=private|group` and `sendMode=direct|identity`. Identity mode also saves `senderAgentId` and `senderAgentName`; direct mode retains neither. Recheck the identity after changing the destination or type.

This explicit mode sends the rendered rule template as the message body, without persona prompts or control blocks. For example, `{sender}({userId}) : {message}` produces `Example(123) : hello`. Identity mode uses `SendGrokBotAgentMessage` to address the group directly, not the Bot's default private chat. Invalid destinations, identities and uncertain results never fall back to default sessions.

`POST /api/agent/threads` requests for `send` / `reconcile_delivery` carry `grokBotDelivery: {deliveryType, sendMode, senderAgentId?}`, the original `threadId` and a stable `deliveryId`. Reconcile uncertain outcomes without replacing the key. Verify configuration persistence, service acceptance and actual target-group display separately. Real bidirectional delivery remains experimental until accepted.

Reverse messages use the existing NapCat channel with the QQ group destination. These options do not create a Grok inbound subscription. Verify the Grok source, group filter, QQ target and loop prevention separately; private-chat relay instructions are not direct delivery.

Reuse a valid session ID directly. Record session creation, message acceptance and answer completion separately. A first-turn timeout does not justify a replacement session. Repeated requests retain the original delivery ID and full payload; a changed payload with the same ID must be rejected.

HTTP 202 or `delivery_unconfirmed` retains the original request. Use `reconcile_delivery` to inspect its evidence on the same owner instead of starting another Bot turn. If evidence cannot be read, keep the outcome unconfirmed.

For ordinary Agent endpoint delivery, the caller's `deliveryId` is an idempotency key and Manager derives an `agent-<64 lowercase hexadecimal digits>` identity scoped to the actual source. Explicit native delivery retains the caller's key in `delivery.deliveryId`, with `messageId` identifying the native operation. Replies and reconciliation retain the response identity for their mode rather than recomputing or mixing identities. Codex Desktop preserves that identity in the structured envelope. If a historical message has one additional UUID transport suffix, recovery still requires its original structured identity, exact prompt hash, target owner and authorization incarnation. Altered bodies, quotations and repeated suffixes cannot establish a receipt.

Acceptance records separately establish Rabi acceptance, Grok owner acceptance, Bot answer completion, Rabi reply acceptance and receipt at the destination. One HTTP success proves only its own segment.

## Acceptance

- Two consecutive deliveries reuse one real Bot session; a display-name change does not alter identity.
- The Bot delivers to Codex using its own source identity and returns a formal reply to the original request.
- A QQ message reaches the Bot through its Route and returns through the original NapCat instance to the correct group/DM, quoting the original message.
- Repeating one delivery ID causes only one acceptance; payload conflicts and incorrect sessions, owners or reply request IDs are rejected.
- Timeouts, restarts and late receipts retain the original request; an offline Bot or Desktop fails closed.
- Matching tests, build and managed-runtime checks record their actual coverage. Missing real round-trip evidence keeps maturity experimental.

External-message tests use an explicitly authorized original destination. Without authorization for a concrete group, DM or persistent task, validate requests, rejection and recovery against a local test endpoint first.

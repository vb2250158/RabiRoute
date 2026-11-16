> Historical task material, reviewed on 2026-11-14. The current C workspace and installed Host are 0.15.2 (`dcfb8a42`). This document preserves its original task-stage content. Version references, line numbers and completion markers retain their original context. Verify current behavior against the [code architecture](code-architecture_en.md), [Agent integration requirements](agent-adapter-standard-requirements_en.md) and formal acceptance evidence.

<!-- docs-language-switch -->
<div align="center">English | <a href="./message-assembly-architecture.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Message assembly architecture

This document traces how a raw message becomes an Agent-readable prompt in RabiRoute: five layers, three coexisting assemblers, and the gaps between them. Conclusions come from source reading with exact locations.

## 1. Five layers

```
Message ingress → RouteDecision → Context assembly → Delivery envelope → Agent delivery
                                                                              ↓
                                                                     Reply and session
```

| Layer | Location | Responsibility |
| --- | --- | --- |
| Ingress | `src/adapters/*` | QQ / WeChat / WeCom / Feishu / Webhook / RabiLink / voice / health / heartbeat, producing a `ForwardRecord` |
| Routing | `src/routing/routeDecision.ts` | Match rules from `personaConfig.json`, produce a `RouteDecision` |
| Context assembly | `src/routing/agentPacket.ts` | Compose record, role, plan, memory, and skill index into sections |
| Delivery envelope | `src/shared/rabiMessage.ts` | `## 消息源` + `## 消息内容` |
| Agent delivery | `src/forwarding.ts`, `src/agentThreads.ts` | `deliver()`, `/api/agent/threads`, endpoint |
| Reply and session | `src/agentSend.ts` | Outbox, `/api/agent/send`, delivery ledger |

## 2. Three assemblers

### 2.1 Primary Agent packet (brief, production)

`buildAgentMessage`, `src/routing/agentPacket.ts:1146-1218`.

| Section | Content |
| --- | --- |
| 当前情况 | Event **title**, role, route kind, source device, event time, trigger, host, voiceprint |
| 近期情况 | Last 3 messages, each truncated to 300 characters |
| 附件 | From `attachmentLines` |
| 角色入口 | Remote persona only: device and query URL |
| 待整理记忆 | `manual_trigger` + `memory-consolidation` only |

Body: original message plus a「补充」section. Control block: `查询入口` (`GET /api/agent/help`, reply locator).

Call site: `src/forwarding.ts:1124`, the only production caller, and it passes no `contextDetail`.

### 2.2 Primary Agent packet (detailed, tests only)

`buildDetailedAgentMessage`, `src/routing/agentPacket.ts:1220-1521`, twenty sections including event info, recent messages, read index, attachments, focused discussion, immediate addressed context, CQ-code parsing, identity, situation record, mobile config assistant, remote role, role paths, memory and plan, plan assistant sessions, pre-work context confirmation, voice classification, logs, remote computer, and remote device entries.

Reached only when `options.contextDetail === "full"`, which appears solely in `agentPacket.test.ts`, `remotePersonaClient.test.ts`, and `routeDecision.test.ts`.

### 2.3 Message-processing Agent packet

`messageGroupPrompt`, `src/forwarding.ts:311`, delivered through `deliverPacketToMessageAgent` (`:333`). Used for message-group scheduling when the message-processing Agent is enabled; it does not pass through either version above.

## 3. Why the difference matters

| Information | Brief | Detailed |
| --- | --- | --- |
| Event title | Yes | Yes |
| Message ID | **No** | Yes |
| Quote chain / mentioned original | **No** | Yes |
| CQ-code parsing | **No** | Yes |
| Identity and speech habits | **No** | Yes |
| Situation record | **No** | Yes |
| Plan assistant sessions | **No** | Yes |
| Log paths | **No** | Yes |
| Remote computer / device entries | **No** | Yes |

In production, the primary Agent cannot see message IDs, quote chains, or raw mention codes. Precise quoting therefore depends on the send locator in `sendRequestJson` (`routeId` / `channel` / `params`), not on message identity.

## 4. Issues

**P1 Two versions coexist and only the brief one runs.** `contextDetail` has no production caller, so the twenty-section path is unreachable at runtime, while `docs/current-capabilities.md` line 85 describes capabilities belonging to it.

**P2 The brief version lacks message identity.** The event section carries a title but no `messageId`; recent messages are capped at three, each truncated to 300 characters.

**P3 Envelope completeness depends on a source existing.** See [Agent delivery envelope audit](agent-delivery-envelope-audit_en.md).

**P4 The three assemblers share no contract.** Section lists, envelope handling, and source construction are implemented separately with no common completeness check.

## 5. Recommendations

1. Decide what `contextDetail` means as a product: expose the detailed version through route configuration, or delete the branch and fold the needed sections into the brief one. A second implementation reachable only from tests should not be kept.
2. Add `messageId` and quote-chain IDs to the brief version. Both already exist on `record`.
3. Converge the three assemblers onto one section-list definition, enabling sections rather than forking functions.
4. Align `docs/current-capabilities.md` with the version actually used.

## Related documents

- [Agent delivery envelope audit](agent-delivery-envelope-audit_en.md)
- [Code architecture](code-architecture_en.md)
- [Standard Agent adapter requirements](agent-adapter-standard-requirements_en.md)

---
id: configuration-triage
title: Configuration triage
summary: Diagnose RabiRoute setup issues by separating message input, route match, agent delivery, and outbound reply.
keywords: configuration, triage, route miss, agent delivery, outbox
source: public example role skill
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Configuration triage

Use this skill when the user says routing, delivery, or reply behavior is broken.

Separate the problem into layers before suggesting a fix:

- Message input: did the platform adapter receive and normalize the event?
- Route match: did a route profile and notification rule match?
- Agent delivery: did RabiRoute build an AgentPacket and deliver it to the selected adapter?
- Outbound reply: did the response go through outbox/action gate, or was it kept as a draft?

Ask for the smallest missing fact only after checking the available status, logs, or route configuration.

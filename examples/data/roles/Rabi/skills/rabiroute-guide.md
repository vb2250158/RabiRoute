---
id: rabiroute-guide
title: RabiRoute guide
summary: Explain RabiRoute as a message gateway and policy router without turning it into an Agent OS.
keywords: RabiRoute, route kind, policy router, gateway, agent adapter
source: public example role skill
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# RabiRoute guide

Use this skill when the user asks what RabiRoute is, how routing works, or where a message should be handled.

Keep the product boundary clear: RabiRoute receives events, records them, decides route policy, prepares context, and delivers to a handler. The downstream Agent, workflow, script, or human queue performs the actual work.

Prefer small concrete explanations: input adapter, route decision, AgentPacket, agent adapter, and outbox/action gate.

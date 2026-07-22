<!-- docs-language-switch -->
<div align="center">
English | <a href="./persona-route-workbench-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Persona Route Workbench Plan

> Status: partially implemented. Persona speech-keyword editing and the 11 per-endpoint recent-context controls are implemented; the side-effect-free single-route-profile `RouteDecision`/`AgentPacket` dry-run preview is not.

The proposed workbench improves the RibiWebGUI persona page with an explainable preview and diagnostic tool. It is not a dynamic persona selector or a clone of a competing Agent editor.

## Current fact model

```text
adapterConfig.json binds agentRoleId
  -> endpoint normalizes an event to a route kind
  -> gateway iterates active route profiles
  -> notification rules match inside each profile
  -> matched rule + bound role paths build AgentPacket
  -> handler adapter delivers to Codex/other handler
```

RabiRoute does not choose a persona by message content. Preview answers:

1. For this already-bound route and simulated event, which rule matches?
2. What packet would the handler receive?

## Proposed first release

Already implemented persona controls are not part of the remaining preview work: `speechTriggerKeywords` has a multi-value editor, and `recentMessageLimits` has 11 independent `0–200` slider-plus-exact-input controls with a schema default of `100`. Zero disables injection only.

- Select one route profile and one simulated route kind.
- Enter sanitized message/source/target fields.
- Show normalized route text and all rule match results.
- Show the chosen rule and generated template values.
- Preview the generated packet with secrets/private content redacted.
- Explain why a rule did not match.
- Keep a separate explicit button for a real test trigger.

## Required backend contract

The dry run must call pure/isolated construction code, not `forwardMessageAndWait`.

It must not:

- write message, packet, delivery, or replay logs;
- deliver to a handler;
- send through Outbox;
- refresh recent/consolidated memory `viewedAt`;
- archive plans;
- create a memory-consolidation run;
- start or stop a gateway.

Because current `buildAgentPacket` takes a live role-knowledge snapshot with side effects, the preview needs a dedicated snapshot/preview mode or preloaded immutable role-knowledge input.

## UI model

- Route/role summary: fixed `agentRoleId`, `configName`, route profile, handler, and cwd.
- Simulation form: route kind and safe event fields.
- Rule table: enabled state, kinds, regex, target filters, and match reason.
- Decision view: selected rule and variables.
- Packet view: generated sections and reply context with redaction.
- Diagnostics: missing role files, invalid regex, unsupported route kind, and configuration warnings.

## Real test boundary

A real test is a separate, clearly labeled action because it writes logs and may start/steer a handler turn. It must never be triggered by merely opening or editing the preview.

## Acceptance

- Preview results match production routing logic for the same sanitized input.
- Preview has zero runtime side effects.
- The UI never implies that a persona was dynamically selected.
- Secrets and private runtime paths/content are redacted.
- The user can distinguish preview from a real trigger at a glance.

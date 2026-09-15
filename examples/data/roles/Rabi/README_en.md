<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi

Rabi is RabiRoute's rabbit-eared guide and the character used by the default public Route.

This directory is a copyable persona example for `data/roles/Rabi/`. It shows how a companion persona can receive QQ and heartbeat events, explain routing and context in approachable language, and maintain plans and memories without changing RabiRoute's boundary as a Policy Router.

Webhook and voice-transcript input are optional extensions. They require a matching message adapter and Route configuration; they are not enabled merely by copying this persona.

Rabi's recent route also keeps live local speech capability separate from a static target-machine report. RabiSpeech is TTS/ASR infrastructure that does not enter an Agent, RabiLink is the system transport, and glasses, phones, or other clients remain the actual callers.

In version 0.3.1, plan approvals can select independent changes per question and show implementation details. Additional information returns the task to analysis; only explicitly approved scope may run. Web hot patches remain experimental: initial installation or backend changes require a full upgrade, and a successful build does not establish installed rollback acceptance.

In version 0.3.2, All-day Recording source is integrated into the phone app: phone, glasses and health devices share one capture coordinator, capture mode is independent from pause, the same durable audio segments serve local playback and later processing, and video audio is derived only after recording stops. New records freeze source, capture ID, persona, processing policy and target PC identity; local-only stays local, transcription-only does not invoke an Agent, and a missing new PC/Relay capability or target identity defers instead of downgrading or retargeting. The phone app is source-integrated only: build, deployment, glasses and 24/72-hour endurance acceptance are separate. Plan state is split into a fixed activation state plus Agent-configurable markers, and pause is a marker only; the DSH web session bridge now exchanges a cookie from the launch login URL, so the old unauthenticated bridge gets HTTP 401.

Version 0.3.3 makes WorkBuddy a deliverable Agent endpoint too. A message no longer starts a headless process; it goes through the local gateway that the bound task's own session process exposes, pinned to the full session ID, so the message lands in the conversation area of the task the user already owns and is executed by that task with its own model, tools and approvals. Delivering twice to the same ID does not create a second task. The gateway password is injected into the session process by the WorkBuddy desktop and is unreadable by RabiRoute as a separate process, so the user records it locally once; without it, delivery fails closed instead of sending an unauthenticated request. WorkBuddy also supports lifecycle hooks on par with Codex and DSH, reusing the same Manager contract for entry-context injection and plan completion reporting. The capability declaration stays honest: WorkBuddy declares message processing and hooks only, while plan assistants and memory consolidation remain Codex- and DSH-only, so the UI never offers a panel whose calls would necessarily fail. The endpoint is still experimental: no desktop pairing handoff exists yet, and cold start is unverified.

## Directory contents

- `persona.md` defines identity, voice, boundaries, and routing behavior.
- `personaConfig.json` contains sample persona automation rules, recent-message limits, and may reference a same-directory persona image through `avatar`.
- `growth.md` describes how Rabi reflects and evolves.
- `skills.md` indexes the capabilities Rabi maintains.
- `skills/one-plan-one-task-tracking.md` is a platform-neutral plan-tracking example.
- `prompts/` contains scenario-specific runtime prompts.
- `plans/` and `memory/` demonstrate Agent-maintained context structures.
- `old/` is reserved for backups created before persona changes.

The runtime-semantic files above remain the authoritative source and are intentionally not duplicated into English variants. Translating a persona or prompt can change behavior, so language changes require a separately reviewed runtime entry.

## Rabi's story

Rabi imagines messages as parcels crossing a sea of stars. NapCat, Webhook, and heartbeat are ports; Routes are shipping lanes; personas label the intended recipient; the Agent at the destination performs the actual work.

The story grew with the project. Early RabiRoute only carried QQ messages toward Codex. As message adapters, route kinds, templates, health details, and persona-owned knowledge were separated, Rabi learned that successful delivery is not enough: every parcel also needs a reliable origin, context, policy, and return path.

That metaphor preserves the project's central boundary. RabiRoute does not become the answering bot or a complete Agent OS. It records events, applies routing policy, renders context, and delivers work to the selected handler. The handler answers, writes code, runs workflows, or calls tools.

Rabi also represents the project's preference for careful, incremental improvement. She should sound warm and playful, but never trade away factual accuracy, privacy, or action boundaries for charm.

When copied into `data/roles/Rabi/`, this example is more than a configuration bundle. It is a public demonstration of how a distinctive persona can live on top of a routing layer while keeping the router and the working Agent cleanly separated.

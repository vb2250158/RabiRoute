---
name: "aiui-dev"
description: "Develop and debug AIUI agents, Pages, Widgets, Agent Workers, built-in components, WXSS, and runtime APIs. Use when generating or reviewing AIUI .ink, app.json, page logic, UI, or API integrations."
---

# AIUI Development

Build AIUI agents from the current contracts in this skill. Do not assume an API, component, CSS property, browser behavior, or lifecycle merely because it exists on the Web or in WeChat Mini Programs.

## Load Only What the Task Needs

- Read [framework.md](./references/framework.md) for project structure, `app.json`, Page, Widget, Agent Worker, SFC, modules, resources, packaging, or TypeScript.
- Read [events.md](./references/events.md) for lifecycle, interaction, key, focus, voice wakeup, head gesture, and environment-awareness events.
- Read [components.md](./references/components.md) before using or reviewing built-in components and their attributes or events.
- Read [wxss.md](./references/wxss.md) before writing styles, layout, selectors, animation, or custom fonts.
- For keyframes, animation events, text-triggered decorations, or 2D transforms, also read [animation.md](./references/animation.md).
- Read [monochrome-green.md](./references/design/monochrome-green.md) only for the monochrome-green Rokid Glasses visual language.
- Read [full-color.md](./references/design/full-color.md) for the Rokid Color full-color visual language and adaptive layouts.
- Read [APIs index](./references/apis/index.md), then its matching domain file, before using runtime APIs.
- For recording source selection or microphone modes, read [media APIs](./references/apis/media.md#recording-source-and-microphone-mode).
- For Widget or Agent Worker instance methods, read [Widget API](./references/apis/widget.md) or [Agent Worker API](./references/apis/agent-worker.md).
- Read and apply [delivery checklist](./references/checklist.md) before declaring a generated or modified AIUI agent complete.
- Start from the matching scaffold when useful: [minimal Page](./assets/minimal-page.ink), [minimal Widget](./assets/minimal-widget.ink), or [minimal Agent Worker](./assets/minimal-agent-worker.js).

Do not load every reference for a narrow task. For example, an Agent Worker normally needs `framework.md`, `events.md`, and `apis/agent-worker.md`, but not Canvas or the full component catalog.

## Core Authoring Rules

- Register App, Page, Widget, Component, and Agent Worker logic with `export default { ... }`; do not use `App()`, `Page()`, `Widget()`, or similar registration functions.
- Use either a multi-file Page or a single `.ink` Page for one route, never both.
- A `.ink` Page uses `<script def>`, `<script setup>`, `<page>`, and `<style>`. A Widget replaces `<page>` with `<widget>`.
- Declare every Page, Widget, Agent Worker, and custom component in the appropriate configuration before using it.
- Declare required capabilities in `app.json.permissions`; handle device authorization failures separately.
- Treat Widget `family` as a size category. Use relative layout and never hardcode the root to the current Glasses pixel size.
- Use `agentWorkers`, not the removed `workers` field. Extend asynchronous `onOpen` work synchronously with `event.waitUntil(promise)`.
- Use data binding for rendered state and `this.setData()` to update it.
- Page `onReady()` and component `lifetimes.ready()` run once per instance after their first visible frame is presented; parsing or layout completion alone is insufficient.
- Resolve packaged resources from project paths; do not invent filesystem or network access that the target does not expose.
- Treat conversation-flow cards as display-only unless the task explicitly targets an interactive full-screen Page or Widget.

## Target and Design Choice

Before styling, determine the intended surface:

- Conversation-flow card: compact, display-only information.
- Full-screen Page: interactive agent UI.
- Widget: compact `1x1` or `1x2` surface with Widget lifecycle.
- Monochrome-green Rokid Glasses: apply `design/monochrome-green.md` after the general WXSS rules.
- Rokid Color: apply `design/full-color.md` after the general WXSS rules.
- Other displays: use theme tokens and task requirements; do not automatically apply the monochrome-green visual language.

## Runtime API Workflow

1. Open [references/apis/index.md](./references/apis/index.md) and select the domain.
2. Confirm the exact constructor or method, parameters, return type, events, errors, permissions, and lifecycle in that domain reference.
3. If the API is absent or the requested overload is not documented, inspect current Ink types or implementation rather than guessing.
4. Keep capability checks and cleanup close to the code that acquires the resource.

## Completion Checks

Run the [AIUI agent delivery checklist](./references/checklist.md). Report which executable checks ran, what they proved, and any target-device behavior that remains unverified. Do not call an agent runnable only because its files look structurally correct.

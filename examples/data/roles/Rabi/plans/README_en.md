<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi plan examples

This directory demonstrates the public Role Knowledge plan layout.

Plans are maintained by an Agent through RabiRoute interfaces. They are neither chat logs nor an execution queue.

Recommended statuses are `未开始`, `进行中`, `暂停`, `已完成`, and `已归档`. A paused plan preserves its current step and `currentStepId` as the resume position, stays out of Current, and does not expose approval presentation. Completed plans are currently archived after a fixed 72-hour retention window; this is not yet a public persona setting.

Unarchived examples live under `items/active/`. RabiRoute moves archived entries to `archive/`.

`index.json` is a lightweight preview for UIs and Agents. `unarchivedPlanIds` includes plans in the not-started, active, paused, and completed states. The JSON files under `items/active/` remain authoritative.

All examples are sanitized. Do not include real conversations, account IDs, tokens, cookies, usernames, private paths, or runtime data.

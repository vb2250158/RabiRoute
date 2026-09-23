English | [简体中文](workspace-plan-query.md)

# Workspace plan queries

`POST /api/roles/:roleId/plans/query` is read-only pagination using the same recursive keyword matching, status/tag filters and sorting as WebGUI. The body accepts `query`, `cursor`, `limit` (1–250), `view`, `sort`, `statuses` and `tags`.

Required `bindingScope` contains `agentType`, an absolute `workspace`, and host-verified `sessionIds`. A task or secretary binding must match all three. An empty identity list returns an empty page. Scope filtering precedes sorting, pagination, totals and facets. Multiple bindings never duplicate a plan. The caller supplies existing session identities; this endpoint does not query an Agent host.

The DSH Rabi plugin matches workspaces against routed personas, then reads summary pages per role in parallel. Button discovery reads no plans. Closing the dialog cancels reads and its event subscription. Rabi WebGUI owns on-demand plan details.

## Status-driven advancement

`GET/PUT /api/roles/:roleId/plan-advance/settings` stores status rules per persona and workspace. `POST .../check` returns candidates, blocking reasons, fingerprints, and the effective prompt without dispatching. `POST .../run` requires the checked fingerprints and rechecks plans, approval, the original bound session, and idle state before reserving dispatch receipts. Automation defaults off; prompts come from persona status configuration. Receipts durably deduplicate each workspace and plan, and uncertain outcomes stop automatic retries. Dispatch uses the formal Agent thread bridge. DSH uses `queue` so a new turn starting after the idle check is not interrupted; the original session is instructed to reread the plan before acting. The host supplies verified workspace `sessionIds`; Rabi never guesses sessions from titles.

English | [简体中文](workspace-plan-query.md)

# Workspace plan queries

`POST /api/roles/:roleId/plans/query` is read-only pagination using the same recursive keyword matching, status/tag filters and sorting as WebGUI. The body accepts `query`, `cursor`, `limit` (1–250), `view`, `sort`, `statuses` and `tags`.

Required `bindingScope` contains `agentType`, an absolute `workspace`, and host-verified `sessionIds`. A task or secretary binding must match all three. An empty identity list returns an empty page. Scope filtering precedes sorting, pagination, totals and facets. Multiple bindings never duplicate a plan. The caller supplies existing session identities; this endpoint does not query an Agent host.

The DSH Rabi plugin matches workspaces against routed personas, then reads summary pages per role in parallel. Button discovery reads no plans. Closing the dialog cancels reads and its event subscription. Rabi WebGUI owns on-demand plan details.

## Status-driven advancement

`GET/PUT /api/roles/:roleId/plan-advance/settings` stores status rules per persona and workspace. `POST .../check` returns candidates, blocking reasons, fingerprints, and the effective prompt without dispatching. `POST .../run` requires the checked fingerprints and rechecks plans, approval, the original bound session, and idle state before reserving dispatch receipts. Automation defaults off; prompts come from persona status configuration. Receipts durably deduplicate each workspace and plan, and uncertain outcomes stop automatic retries. Dispatch uses the formal Agent thread bridge. DSH uses `queue` so a new turn starting after the idle check is not interrupted; the original session is instructed to reread the plan before acting. The host supplies verified workspace `sessionIds`; Rabi never guesses sessions from titles.

Each check reads the complete DSH session catalog once per host, and dispatch reads one fresh status snapshot for its session groups. It does not scan the entire catalog once per plan. DSH status reads have a 10-second limit; a timeout or unreachable host still blocks dispatch. If a new turn starts after the snapshot, queue delivery waits for that turn to finish.

The dispatched message includes the editable prompt for that status, its name and description from the persona workflow, the plan and current-step identity, and the inspect-only or continue-authorized-work constraint. The agent must reread the plan and feedback. The status description explains the phase without expanding authorization, and checking does not directly change plan status. The persona workflow owns status descriptions; workspace advancement settings store only prompts and trigger rules.

English | <a href="./README.md">简体中文</a>

# YeYu Gamer Manager Plugin

This plugin provides a disabled-by-default local facade for YeYu Gamer. The target is fixed to `http://127.0.0.1:8877/api/v1`; the plugin only reads health, meta, snapshot, and capabilities and can create only `mode: "plan"` Agent work items.

Configuration belongs to the Profile instead of `data/manager.json`. The Bearer token is read from the local YeYu Gamer runtime directory only for protected snapshot/capability reads or work-item creation and is never stored in the Profile, responses, or logs.

The same executable contracts install five public routes and publish them to the Agent catalog. The former manual route declarations and HTTP handler have been removed:

| Operation | HTTP endpoint | Result |
| --- | --- | --- |
| `manager.yeyu-gamer.health.read` | `GET /api/agent/yeyu-gamer/health` | `200` native health view |
| `manager.yeyu-gamer.meta.read` | `GET /api/agent/yeyu-gamer/meta` | `200` native instance metadata |
| `manager.yeyu-gamer.snapshot.read` | `GET /api/agent/yeyu-gamer/snapshot` | `200` native snapshot and `stateVersion` |
| `manager.yeyu-gamer.capabilities.read` | `GET /api/agent/yeyu-gamer/capabilities` | `200` native capability catalog |
| `manager.yeyu-gamer.work-items.create` | `POST /api/agent/yeyu-gamer/work-items` | `202` native plan-command receipt |

Success bodies use `{code:0,data}`. Response schemas share their definitions with the native client, preserving upstream extension fields and existing optional fields. Unknown query fields are ignored. Creation accepts `workItem`, `idempotencyKey`, `expectedStateVersion` and optional `requestId`. The native owner forces `mode: "plan"` and `requestedBy: "rabiroute"`; caller-supplied execution settings do not grant execution permission.

Authenticated enabled remote connections use these public operations without another feature grant. Each request captures its original client and configuration before body decoding. The original connection is revalidated before credential access, actual dispatch and result disclosure. Configuration changes do not redirect accepted work to a new target. HTTP disconnection or plugin shutdown cancels the original request; shutdown joins admitted tasks. The upstream timeout remains controlled by native configuration.

Read a fresh snapshot and use its `stateVersion` before creating a new plan. Retain the original idempotency key, complete payload, expected version and native receipt's `commandId` / `statusUrl`; this facade has no separate receipt lookup endpoint. Revocation strips business data and returns only execution progress: `not_started` means native dispatch was not entered; `unknown` means native transport was entered and its outcome needs reconciliation. `202` does not prove game execution or acceptance. Reconcile uncertain results with the original owner before retrying, without automatically creating a replacement plan.

Source tests use isolated directories, generated fixture credentials and controlled local HTTP services. They do not exercise the real game port, user game data, installed updates or two-computer execution.

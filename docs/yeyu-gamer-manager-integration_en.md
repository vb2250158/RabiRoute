<!-- docs-language-switch -->
<div align="center">
English | <a href="./yeyu-gamer-manager-integration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Local YeYu Gamer Manager integration

Status: **Experimental integration**. The typed client, local Manager facade, and unit tests are implemented. A formal YeYu Gamer Manager installation and live machine acceptance run remain separate work. The module is disabled by default and does not start a game or a legacy automation script when RabiRoute is installed.

## Boundary

RabiRoute connects only to `http://127.0.0.1:8877/api/v1` and uses only five YeYu Gamer Manager endpoints:

| Method | YeYu Gamer Manager path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Read health state. |
| `GET` | `/meta` | Read version and host policy. |
| `GET` | `/snapshot` | Read the state snapshot and `stateVersion`. |
| `GET` | `/capabilities` | Read the capability catalog without invoking a capability. |
| `POST` | `/agent/work-items` | Create an Agent work item with `mode: "plan"`. |

This integration is not a generic HTTP, shell, path, or click executor, and it is not a complete `AgentAdapterType`. It has no claim, decision, or capability-invocation method. It cannot read legacy `daily-gui-config.json` or `game-automation-policy.json`, and it cannot call the legacy desktop application or scripts. `POST /agent/work-items` records a reviewable plan item; it does not prove that a game started or completed.

## Configuration

The YeYu Gamer integration is the independent `io.rabiroute.manager.yeyu-gamer` plugin. Its enablement and configuration both belong to the active plugin Profile. The distribution Profile includes the instance with instance-level `enabled` set to `false`:

```json
{
  "id": "manager:yeyu-gamer",
  "package": "io.rabiroute.manager.yeyu-gamer",
  "version": "1.0.0",
  "enabled": false,
  "config": {
    "baseUrl": "http://127.0.0.1:8877/api/v1",
    "requestTimeoutMs": 3000
  },
  "grants": []
}
```

For source builds, edit `plugins/profiles/desktop.json`. For an installed environment, copy the distribution Profile to a local configuration directory and select that copy with `RABIROUTE_PLUGIN_PROFILE` instead of editing build output. See [`examples/schemas/yeyu-gamer-manager-config.schema.json`](../examples/schemas/yeyu-gamer-manager-config.schema.json) for the complete field constraints. `baseUrl` cannot point anywhere else. The default Windows runtime directory is `%PROGRAMDATA%\YeYuGamer\runtime`. Configure an absolute local `runtimeDir` only when YeYu Gamer is installed elsewhere on the same machine; UNC and SMB paths are rejected.

YeYu Gamer Manager creates `secrets\actors\rabiroute.token` on first startup. RabiRoute reads it for protected snapshot/capability reads and work-item dispatch, then sends it as the Bearer credential to port 8877. Health and meta probes remain unauthenticated. Never copy the Token value into the Profile, logs, documentation, or a request body. Protected calls fail closed when the file is absent or malformed.

To enable the integration, change only this instance's `enabled` field to `true`; do not add a second business switch. Plugin reconciliation can hot-replace the instance after the Profile changes. Production runtime must still use the local installation rather than the NAS source directory.

## Local RabiRoute facade

RabiRoute Manager registers only these paths for loopback callers:

```http
GET /api/agent/yeyu-gamer/health
GET /api/agent/yeyu-gamer/meta
GET /api/agent/yeyu-gamer/snapshot
GET /api/agent/yeyu-gamer/capabilities
POST /api/agent/yeyu-gamer/work-items
```

GET responses use the normal RabiRoute envelope:

```json
{
  "code": 0,
  "data": {
    "stateVersion": 42
  }
}
```

Read a fresh snapshot before dispatch and use `data.stateVersion` as `expectedStateVersion`. Reuse the same stable `idempotencyKey` when retrying one logical request:

```json
{
  "workItem": {
    "kind": "run_game",
    "gameId": "ZZZ",
    "cadence": "daily",
    "note": "Create a daily plan item for Agent review."
  },
  "idempotencyKey": "route-event-opaque-id",
  "expectedStateVersion": 42,
  "requestId": "optional-correlation-id"
}
```

The client fixes `mode: "plan"` and `requestedBy: "rabiroute"`. A successful response uses status `202`, with the YeYu Gamer command receipt in `data`. The receipt proves that Manager accepted the record; it is not execution-completion evidence.

## Acceptance without starting a game

The integration can be checked without running a game:

1. Confirm that YeYu Gamer Manager is running locally on port 8877 and has created `rabiroute.token`.
2. Enable the configuration and restart RabiRoute Manager.
3. Read `health`, `meta`, `snapshot`, and `capabilities` through the RabiRoute facade.
4. If the write contract must be checked, dispatch only a `kind: "observation"` plan item and inspect the `202` receipt. Do not claim the item, invoke a capability, or treat the receipt as a game result.

While disabled, valid facade calls fail closed with `yeyu_gamer_disabled` and do not send a request to port 8877.

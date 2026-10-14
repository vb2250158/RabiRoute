English | [简体中文](automation-agent-delivery.md)

# Agent delivery targets in automation

Agent settings define recipients and execution parameters. Persona automation rules select the recipient for each message. Configuring a primary Agent, secretary, or message pool does not redirect other rules.

## Configure a rule

Open **Persona → Automation**, edit a rule, and choose **Delivery target** under **Notify Agent**:

- **Primary persona:** use the route's current primary binding.
- **Plan secretary:** use the secretary bound to the message's associated plan. Missing plans or bindings fail explicitly.
- **Message processing Agent:** reuse the existing pool, tasks, and model settings.
- **Memory consolidation Agent:** create or reuse the existing consolidation session.
- **Custom:** select an Agent instance and an existing session. Search by name or ID within the session selector. Results show names with full IDs and workspaces below them, and support loading more. Changing the Agent clears the previous session. Done is disabled until both fields are selected; session details can be expanded.

Save and refresh to verify the selection. Changing the primary binding affects subsequent rules referencing it; custom sessions remain unchanged.

## Configuration ownership

`automationRules[].action.target` in the persona's `personaConfig.json` owns the target selection. References store stable recipient IDs. The `agentRecipients` catalog and existing instance, session, and model settings belong to the route's Agent configuration.

```json
{
  "id": "private-to-primary",
  "enabled": true,
  "trigger": { "type": "message", "routeKinds": ["private"] },
  "action": {
    "type": "deliver_agent",
    "target": { "kind": "recipient", "recipientId": "primary" },
    "template": ""
  }
}
```

Custom targets store `kind: "session"`, `agentTargetId`, `agentAdapter`, `sessionId`, `sessionName`, and `workspace`. Instance and full session IDs distinguish identical names. Delivery to a selected session does not create a replacement by name.

Rules shared by several routes can use `sourceRouteIds` to restrict their scope. Without it, the rule applies to all routes using the persona. Defaults are generated during initialization or migration, not restored on every read.

## Upgrade and recovery

Preview the affected persona, supplying the directory containing all routes that reference it:

```powershell
node --import tsx scripts/migrate-agent-delivery-targets.ts --persona data/roles/Example/personaConfig.json --routes data/route
# Review the preview, then repeat with --apply.
```

Migration converts the old pool and consolidation switches into explicit targets and adds route conditions when old behaviors differ. Existing sessions, secretary bindings, model settings, pool state, and unrelated persona fields are retained. It snapshots original files, checks concurrent changes before writing, and verifies readback. Failure restores written files unless external changes require review. A version marker prevents repeated conversion. Older directory layouts can use the explicit maintenance operation `ManagerConfigRepository.migrateLegacyConfigs()`. Manager startup does not synchronously migrate the entire directory.

Old rules without targets fail until migrated. Runtime delivery no longer uses pool or consolidation switches to select recipients. Historical fields remain migration inputs; independent plan-system configuration keeps its existing contract.

Failed attempts record original rules, recipient definitions, and resolved sessions. Batch retry preserves individual delivery identities rather than creating a merged primary-Agent message. Invalid original bindings fail. Historical records without target snapshots cannot be retried automatically. Selected-session delivery persists pending state and receipts; uncertain outcomes query the original session before any resend.

## Verification

Unit and integration tests cover selection, concurrency, receipt recovery, migration rollback, persistence, and rule projection. Deployment acceptance additionally requires current page resources, Manager version checks, and actual local and remote session receipts. A successful build alone does not establish successful delivery.

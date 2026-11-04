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

Message rules also offer **Include recent messages** and **Recent message count** (1–200) under **Notify Agent**. Each rule controls whether to include the current conversation's last N messages. Disabling this keeps chat records intact. The current message and explicit quoted replies still follow the existing delivery flow. Scheduled tasks do not automatically include chat history.

The count is stored in `automationRules[].action.recentMessageLimit`; `0` disables history. Existing rules without this field retain their previous endpoint count (12 by default). Editing this option saves a rule-specific value. The separate **Message context** tab has been removed from persona settings.

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


## Agent completion files

In Role → Automation → Agent Hooks → Event delivery, NapCat (QQ) rules provide **Include files in automatic delivery**, checked by default. Existing rules without `destination.params.includeFiles` also include files; the string `"false"` opts out and `"true"` enables it explicitly. This setting is saved with the role's Hook rules for each Agent.

After sending the full reply, the Hook uploads files referenced by local Markdown links to the same QQ group or private chat. Absolute paths and `file://` links are supported, including URL encoding, angle-bracket paths with spaces, source line suffixes and anchors. Web links and links in code examples are excluded. Each normalized local path is uploaded once per completion target and turn. The existing Route file policy still applies.

Text parts and files keep independent delivery IDs and persistent receipts. A missing or blocked file does not stop the other files; the Hook reports partial failure. Uncertain or failed receipts remain available for diagnosis and are not blindly resent. The file must be accessible on the Manager computer; a path from another computer does not transfer its contents automatically.


## Flowchart and architecture diagram images

NapCat completion rules include **Automatically recognize flowcharts/architecture diagrams**, checked by default. `destination.params.renderDiagrams` uses `"false"` to opt out and `"true"` to enable explicitly; missing values use the default. Mermaid fenced code blocks are rendered locally to PNG, then sent inline with surrounding text in the original order. Unlabelled fenced Mermaid flowchart, sequence, class, state, ER and architecture diagrams are also recognized. Other code blocks remain text. This does not infer diagrams from arbitrary prose or ASCII art.

Rendering uses the bundled Mermaid dependency and an installed Chromium-family browser, without sending diagram contents to an external service. Flowcharts use wider nodes, tighter spacing and a canvas fitted to the content. Tall flowcharts are sent as consecutive numbered images, split between nodes and edge labels so QQ thumbnails remain readable. Direction, content and explicit line breaks are preserved; standalone PNG export still returns the whole diagram. Other diagram types and Markdown tables remain single images. Existing Route image-output policies and Markdown rendering quotas apply. A failed conversion retains the source with a conversion-failure notice and sends the remaining content. Mixed messages reuse existing delivery IDs and persistent receipts; speech delivery remains text.


## Tables as images

**Automatically render tables** is checked by default in NapCat completion rules. Set `destination.params.renderTables` to `"false"` to opt out or `"true"` to enable it explicitly; existing rules with no value also enable it. Markdown tables are rendered locally to PNG with column alignment, wrapping and emphasis, then sent inline with surrounding text in their original position. This setting is independent of diagram rendering. Table examples inside code fences and ordinary pipe characters remain text; opting out preserves the original table. Rendering uses the existing Markdown image policy and quotas. Speech continues to use text.

## Existing images in completion replies

Original Markdown images are sent inline in their original text order, including local absolute paths, `file://`, relative paths resolved against the task workspace, and HTTP(S) images. This remains active when diagram conversion is disabled. Images are not uploaded again as file attachments; ordinary linked documents still follow the file-delivery option. Code examples remain text.

For a local Codex task, the native thread owner supplies the exact rollout path. The completion reader extracts only successful `image_gen.generation` outputs from the same turn, excluding user inputs, tool screenshots and other turns. These native outputs appear after the final prose, as in Desktop, using inline image bytes without a second disk cache. A generated image already embedded through a local Markdown image is not appended again. Original delivery IDs and receipts still prevent duplicate sends. This native-image extraction requires the local owning Codex history; remote-host native image resources require their owning host to supply media, rather than interpreting a remote path locally.

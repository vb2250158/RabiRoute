<!-- docs-language-switch -->
<div align="center">
English | <a href="./remote-persona-reference.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Use a remote persona from a local Route

Both PCs need distinct instance IDs, connection keys and local connection IDs. If copied configuration causes a remote source to be treated as local, [reset instance identity](user-guide/instance-identity_en.md) on one PC. Changing a display name cannot separate copied identities.

> Status: introduced in 0.3.19 and using unified application authentication in 0.3.22; still experimental. Automated tests cover configuration, bounded reads, identity checks, message delivery packaging and page selection. Complete delivery, recovery and sustained operation across two physical PCs still require acceptance. Both PCs reuse authentication for the same RabiLink application to exchange and pin public keys. Connected devices can use all services actually provided by the PC; persona references retain a fixed read-only alias. The source PC must provide `persona-reference-v1`, `rabilink-application-access-v1` and the corresponding endpoints; older versions need an upgrade.

A local message Route can use persona text, message rules and recent-message budgets owned by another PC. Message inputs, the Agent that actually handles the work, its workspace and message auditing remain those configured for the local Route. Selecting a remote persona does not automatically select a remote Agent or import or synchronize a persona directory.

## Select the persona in the page

1. Open the local WebGUI and the target Route's **Persona configuration** page.
2. Select a source PC in the same RabiLink application in **Persona source PC**. **Refresh remote PCs** rereads device status. The page uses the local managed endpoint for the application-authenticated public-key handshake.
3. Select a persona from the source PC. The default document filename is `persona.md`.
4. Confirm that the text preview and read-only configuration have loaded, then save the Route. Edit persona text, avatars, identities, automation or knowledge on the source PC.
5. Perform one delivery through the Route's existing workflow and check local diagnostics and actual receipt by the target Agent. Reading the preview, saving configuration and completing a real delivery are separate results.

The local source option shows this device's name and RabiPC version. Other PCs show their advertised version; older devices without an advertisement show an unknown version. RabiLink Home also labels this device and displays each PC's version. A device name is not its identity: a row matching this device's ID and GUID belongs to the local option and is not another remote source. If two PCs copied the same identity configuration, verify and separate their identities before selecting a remote persona; changing a display name or disabling self-filtering does not resolve the shared identity. Version text does not replace the `persona-reference-v1` capability or authentication checks.

Offline, authentication-failure, upgrade-required and read-failure states are distinct. A saved remote reference remains selected; a failed read stops Agent delivery through that Route and never substitutes a same-name local persona. The 0.3.22 connection allows all services actually provided by the source PC; persona references themselves still read through the fixed read-only alias.

## Data and execution ownership

| Content | Owner and current behavior |
| --- | --- |
| Persona text, message rules and recent-message budgets | The source PC's persona. Each delivery reads a request snapshot; it is not copied into local persona configuration. |
| Message inputs, actual handling Agent, workspace and input switches | The local Route. The persona reference does not change these selections. |
| Locally received messages, recent-message context, delivery and reply audits | Local `data/route/<configName>/`. They are not appended to a same-name local persona directory. |
| Remote plans, memories, skills and historical material | Manager's global knowledge directory on the source PC. Query on demand through the fixed read-only peer `persona` entry, without substituting same-name material from a custom Route directory; remote paths do not identify local files. |
| Remote schedules, scripts, plan secretaries and memory consolidation | The reference does not start them locally. Their execution still depends on configuration and authorization on the source PC. |
| Hooks and host permissions | A reference does not change local host approvals or apply remote Hook settings to the local host. |

When an outbound message requires language-style validation, the local PC reads the current remote persona configuration and calls source-PC `POST /api/roles/<RoleId>/persona-reference/language-style` with only `{ "text": "text to check", "file": "persona.md", "revision": "current snapshot revision" }`. The source PC obtains the style address from its stored persona configuration and reads its own style files; caller-provided `styleSkillUrl` is rejected. The local PC does not interpret remote file paths. Both Manager identities and the source snapshot revision are checked before and after validation; changes reject the result. Explicit one-send `styleValidation=0` retains existing rules but still requires a successful remote configuration read and cannot bypass offline state, identity failure or denied authentication. A persona preview does not prove complete local integration of avatars, voices or identity material.

Only remote `automationRules` with a message trigger and an Agent-delivery action participate in the local Route's message decisions. Remote schedules and script actions do not run locally. If no remote message rule matches, the local Route records a miss without substituting same-name local rules.

Persona text enters the current Agent context. Associated messages and delivery evidence remain subject to local logging and retention policies. “No persona replication” means there is no second source of truth for persona material, plans or memories; it does not mean that network reads and the current context leave no local data.

The local persona directory and Route message diagnostics do not mix in a same-name local persona. Current local cross-persona messaging, role-panel and plan-feedback entries reject a remote reference as a local persona. Local persona Hooks reject both ordinary remote bindings and older mixed bindings where one Agent owns local and remote Routes. Knowledge reads made by a persona reference use the read-only `persona` alias. Remote mutations or actions use managed `manager` interfaces on the same authenticated connection, retaining source-PC business validation and execution ownership without another service grant.

## Configuration contract

The local `adapterConfig.json` stores reference fields:

```json
{
  "agentRoleDeviceId": "peer-b",
  "agentRoleId": "Example",
  "agentRoleFile": "persona.md"
}
```

This is a field fragment to merge into an existing complete Route configuration. `agentRoleDeviceId` is a stable device ID, not a display name or URL. Empty or absent selects a local persona. A nonempty device ID requires an unchanged valid remote `agentRoleId`; it is never inferred from the Route name or a local persona. IDs with surrounding whitespace, path fragments or non-string values are rejected rather than silently changed into another persona.

Gateway processes receive the same reference through `AGENT_ROLE_DEVICE_ID`, `AGENT_ROLE_ID` and `AGENT_ROLE_FILE`, supplied by Manager. Existing persona rules, context budgets, language-style and Hook projections are not persisted in local adapter configuration. Local Route variables, speech delivery mode and input configuration remain intact.

For remote references, `roleDir` and `rolePath` are empty. Local runtime data and transient context use the Route directory. Code must not construct a local role path from a same-name ID as a fallback.

## Unified RabiLink device connections

Since 0.3.22, PCs enabled in the same RabiLink application authenticate with existing application credentials and automatically exchange and pin Ed25519 keys. New PCs advertise `rabilink-application-access-v1`; selection, probing and first requests share the `bootstrap-application` handshake. Connected devices can use all services actually provided, including Manager and knowledge writes. The source PC must upgrade. Each request still checks application scope, device credentials, current enablement and pinned keys. Changed keys are not silently replaced, and anonymous LAN advertisements cannot establish trust.

`persona` is the fixed read-only API alias used by references; path restrictions belong to that endpoint contract. Full administration uses `manager`. A reference does not automatically execute remote tasks or change local host approvals. Host lifecycle and instance resets remain local Host-owner operations.

`tunnel.json` retains selection, pinned keys and application scope; per-service permission lists are retired. Only successful current-application authentication migrates old records. The released-page `POST /api/rabilink/peer/persona/bootstrap` alias accepts only a device ID and invokes the unified handshake; remove it after page migration. Supported legacy wire kinds, key and transport limits follow the [generic connection contract](rabilink-peer-tunnel_en.md). Read-only acceptance mode still rejects selection changes and tunnels.

## Endpoint and identity fences

The source PC exposes this managed endpoint:

```text
GET  /api/roles/<RoleId>/persona-reference?file=persona.md
POST /api/roles/<RoleId>/persona-reference/language-style
```

`file` accepts one `.md` or `.markdown` filename inside the persona directory. Path traversal and links outside that directory are rejected. Persona text is limited to 2 MiB and `personaConfig.json` to 256 KiB. A missing configuration may use the default projection; malformed JSON fails the read. Oversized documents are rejected rather than truncated and presented as complete.

A successful response is `{ "code": 0, "data": ... }`. `data` contains `schemaVersion: 1`, the actual `roleId`, `file`, `document`, normalized `personaConfig`, a SHA-256 `revision` derived from the text and original configuration, and the source Manager's `applicationGenerationId` and `managerInstanceId`.

The local PC reads remote persona catalogs and configuration through `/api/rabilink/peer/http/<device>/persona/...`. The actual Gateway's internal resolution entry accepts only a local connection with the current Route capability and local Manager identity. It uses the persisted reference; request parameters cannot substitute another device, persona or file. Resolution checks remote `/meta`, tunnel generation, snapshot identity and `/meta` after the read, then rechecks local identity and the Route binding. Gateway results retain local and remote identities separately.

Manager remote HTTP reads have a 20-second budget and a 4 MiB response limit; the complete Gateway request has a separate 25-second timeout. Page previews also have a 25-second timeout and a 4 MiB total-response limit, with an independent 2 MiB document limit and SHA-256 revision validation. Previews and the dedicated document page verify the source `/meta` identity and healthy/degraded readiness before reading, then verify identity only afterward; a health change alone is not a generation change. Previews also require the snapshot identity to match both checks. Snapshots serve the current request and are not durable persona caches.

## Failures and acceptance

| Situation | Result and investigation |
| --- | --- |
| Source PC offline or connection failure | Retain the reference and stop delivery. Check device runtime and the generic connection. |
| Failed application authentication, changed keys or a pinned-key mismatch | Deny access. Check the application connection, device identity and current connection scope. |
| Missing new endpoint or old response format | Report an upgrade requirement. Upgrade the source PC and reread. |
| Missing persona or file, malformed JSON or size limit exceeded | Report a read error. Repair source material without substituting a same-name local file. |
| Either Manager changes generation, the Route binding changes or identities mismatch | Reject the current result. Rediscover the current address and reread. |
| No remote rule matches the message | Record a miss. Inspect source persona rules without defaulting to delivery. |

Automated tests cover save/reload, same-name local isolation, path restrictions, remote policy projection, identity changes, authentication failures and stale page responses. Two-PC acceptance still needs both versions and identities, actual transport, rejection across applications or mismatched pinned keys, same-name persona isolation, a reread after source configuration changes, target Agent receipt and failure closure after disconnection. Local simulations do not replace that evidence.

Further reading: [Routing and personas](routing-and-personas_en.md), [Routing configuration](routing-configuration_en.md), [Persona synchronization retirement](persona-data-sync_en.md), [Generic cross-PC connections](rabilink-peer-tunnel_en.md).

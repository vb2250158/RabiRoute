English | [简体中文](connection-access.md)

# Connections and API access

Status: implemented in 0.3.25. Authenticate a connection once, then use its provided APIs without another grant for each feature, persona or skill. The API catalog describes capabilities and parameters; it is not another permission allowlist.

Local operations use the Manager address published by the current Host. LAN WebGUI uses its existing connection key, remote Agents use their enrolled node credential and registered Agent identity, and devices in the same RabiLink application reuse application authentication. Requests continue carrying the existing credential without another pairing or feature grant. Revoked connections, disabled Agents and stopped services still take effect.

## Removed duplicate restrictions

| Entry | Current behavior |
| --- | --- |
| Xiaomi device control | A working Home Assistant connection can use supported device actions without another control switch. |
| Xiaomi recording reads | Reuse Manager connection authentication without a separate recording token. Users still choose whether to capture recordings. |
| Persona scripts | Configured local automation can run scripts in its persona's `scripts/` directory without another Route permission switch. Remote persona scripts execute on their owning PC. |
| Message sends | Primary Personas, Plan Agents, secretaries and Message Agents use the same send contract, without a primary-only switch. |
| Persona skills | Authenticated Agents can read and download persona skills without a separate Route binding. Reading does not execute scripts. |
| Agent APIs | Authenticated nodes use provided Manager APIs without a second WebGUI administration key for existing routes outside the discovery catalog. Unknown routes still return not found. |
| RabiLink | Authenticated devices in the same application retain default service access without additional service grants. |
| Nodes, Peers and WebGUI settings | Authenticated connections can manage nodes, discover or call Peers, and change LAN access settings without a second administration key. |
| Gamer integration, model directories and recording archive settings | Reuse connection authentication without a loopback-only caller restriction. Model paths, archive ownership, revisions and idempotency conditions still apply. |
| Browser history bridge | Manager business APIs reuse connection authentication; browser extensions still identify their own paired connection with its existing credential. |
| Installed plugins | Use host APIs declared in their Manifest without another Profile `grants` list. Undeclared host APIs remain outside the plugin contract. |

## Requests must still follow their contracts

Messages follow the [delivery contract](rabi-agent-interfaces_en.md): identify the sender, target, reply requirements and correlation fields without impersonating another session or a system message. Device actions use supported capabilities and parameters. State versions, configuration revisions, current Manager identities and stable idempotency keys prevent changes to the wrong object or duplicate execution; they do not ask users to authorize again. After a timeout or uncertain result, read the original receipt rather than resending with a new key.

Files remain inside their owning directories. Path traversal, symlink escapes and mismatched content hashes are rejected. Size, deadline and concurrency limits are service contracts. Plugins use host APIs from their Manifest without another Profile permission grant; process isolation and package-origin checks still apply. Windows administrator rights, platform account permissions and unsupported device capabilities remain owned by their respective systems.

Installers, Host lifecycle and operations that only make sense locally still execute on the local PC. Remote business access does not disguise requests as local traffic. Camera capture, event subscriptions, Route enablement and user-configured approval workflows are feature choices and are not automatically enabled or deleted by this change.

QQ original-message, history and attachment reads retain the direct-local management boundary from 0.3.23 and reject LAN Agent, Relay and P2P proxies. Authenticated remote connections can access model-directory settings but cannot use that connection to read raw QQ media.

The `/api/internal/` persona projection endpoints bind Manager child processes to their current Route and persona identity. Ordinary Agents use the public persona APIs without projection credentials. Instance ID resets and Host lifecycle belong to the current installed Host; requests from another PC cannot become local Host commands.

## Old configuration migration

For existing installations, 0.3.25 still accepts `writeEnabled`, `artifactReadTokenEnv`, `personaAutomationScriptsEnabled` and `codexHooks.onlyPrimaryPersonaCanSendMessages`. They no longer determine access: device control and local scripts are available, primary-only sending is disabled, and recording reads reuse connection authentication. The UI and new examples no longer provide these fields. Compatibility input remains only at configuration boundaries and is scheduled for removal in 0.4.0. Remove these fields during migration; use normal connection setup, automation configuration or `dryRun` rehearsal instead.

Older changelog entries describe behavior at their release date. Use this page and the running API for current operation.

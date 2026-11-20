English | [简体中文](README.md)

# Rabi DSH Context

Forwards session entry, user messages, tool callbacks, and turn completion to Rabi Manager. Manager owns persona context, switches, and decisions; this plugin stores no separate policy.

Click Update Hooks in Agent to install into the local DSH `web` profile, then reload the plugin or restart DSH. Each request discovers Manager through Host and verifies `/meta`. Source and test callers may supply a complete `RABI_MANAGER_URL`. Manager outages are reported without preventing standalone DSH use.

Follow the [shared Agent integration requirements](../../docs/agent-adapter-standard-requirements_en.md#feature-ownership-rabi-first-host-extensions-only-where-necessary). This Hook only supplies DSH lifecycle events and local actions that Rabi cannot capture or apply directly. It does not select memories, define personas, advance plans or schedule cross-Agent tasks; Rabi owns those shared decisions for DSH, Codex and other Agents. Rabi decisions remain subject to DSH permissions. Installation instructions and source code do not prove that the current instance loaded the Hook; verify event arrival at Manager, application of returned context and enforcement of tool denial separately.

This event plugin can coexist with DSH messaging tools. Restrictions imposed by an older messaging plugin remain controlled by that plugin.

Plugin list names and descriptions follow the DSH Chinese or English language setting.

Injected messages use the producer source `source.kind=rabi-dsh-context` for DSH V4 sessions. Subsequent user-prompt submissions exclude context from that same source to avoid sending the plugin's own content back to Manager.

The plugin reads the `startup`, `resume`, `clear`, or `compact` source from DSH `agent/created` and sends `SessionStart` once on that Agent’s first entered model step; a rejected step does not consume it. Ordinary forks and subagents keep the source DSH publishes, without classification by parent fields. Agent disposal clears local state, so resuming the same identity starts a new lifecycle.

When both Rabi DSH hook plugins support shared dispatch, dsh-rabiroute-agent sends each lifecycle event once. Enrolled Rabi Agent instances and explicit bridge endpoints keep their own transport. Manager tool vetoes and Stop continuation decisions are applied to the same session.

When using the native Agent plugin, save `{"hostExecutable":"C:/path/to/RabiRouteHost.exe"}` for `rabi-dsh-context` in DSH Plugin Manager. Use the absolute path to the RabiRoute Host that serves the native Agent's current connection. Hot-reload the plugin after saving. Each request obtains the address from that Host with `--command status --json` and verifies the Manager instance and application generation through `/meta`. The configured path takes precedence over an enrolled instance or environment settings. An unavailable Host or identity mismatch reports a connection failure. Leaving the field empty keeps existing discovery behavior.

Task progress text uses public assistant messages from the current turn. Once DSH begins the next step, the plugin forwards the earlier text and its native message ID over the original session connection. Loading the plugin mid-turn starts observation on the next turn.

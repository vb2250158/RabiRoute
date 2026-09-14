English | [简体中文](README.md)

# Rabi DSH Context

Forwards session entry, user messages, tool callbacks, and turn completion to Rabi Manager. Manager owns persona context, switches, and decisions; this plugin stores no separate policy.

Click Update Hooks in Agent to install into the local DSH `web` profile, then reload the plugin or restart DSH. Each request discovers Manager through Host and verifies `/meta`. Source and test callers may supply a complete `RABI_MANAGER_URL`. Manager outages are reported without preventing standalone DSH use.

Follow the [shared Agent integration requirements](../../docs/agent-adapter-standard-requirements_en.md#feature-ownership-rabi-first-host-extensions-only-where-necessary). This Hook only supplies DSH lifecycle events and local actions that Rabi cannot capture or apply directly. It does not select memories, define personas, advance plans or schedule cross-Agent tasks; Rabi owns those shared decisions for DSH, Codex and other Agents. Rabi decisions remain subject to DSH permissions. Installation instructions and source code do not prove that the current instance loaded the Hook; verify event arrival at Manager, application of returned context and enforcement of tool denial separately.

This event plugin can coexist with DSH messaging tools. Restrictions imposed by an older messaging plugin remain controlled by that plugin.

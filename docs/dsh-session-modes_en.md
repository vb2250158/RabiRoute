<!-- docs-language-switch -->
<div align="center">English | <a href="./dsh-session-modes.md">简体中文</a></div>
<!-- /docs-language-switch -->

# DSH session modes

Expand the DSH adapter parameters on a Route to select a session mode from the live DSH preset catalog. An empty value preserves the current DSH mode. An explicit value is checked against the actual DSH mode when saving, resolving the session and sending a prompt.

The Rabi Assistant preset ID is `rabi-assistant`, registered by `dsh-rabiroute-agent` since 0.13.19. It uses the persona bound through Rabi and exposes only `rabiroute_agent_threads`, `rabiroute_agent_send` and `rabiroute_manager_api`. The tool runtime restricts both visibility and execution; file, terminal, browser and other plugin tools are unavailable.

The Route field is `dshAgentPreset`. DSH rejects mode changes after a session has started a conversation. A rejected selection fails the save or send operation and requires an explicit new session choice. Rabi does not silently create another session or continue delivery with the old mode.

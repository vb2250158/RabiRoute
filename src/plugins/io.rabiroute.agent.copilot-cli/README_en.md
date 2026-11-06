[简体中文](./README.md) | English

# Copilot CLI

This package owns the Agent's settings card, discovery, session operations, and delivery implementation. Manager and Gateway use the same native plugin profile. Disabling rejects new work while admitted operations retain their original leases, sessions, and external execution owners. Package metadata declares supported capabilities and maturity.

The manifest declares `entries.web.module: "./web/client.mjs"` directly. The complete Web build generates this file, re-exporting `activate` from the package's independent `/assets/…` module. The publisher pins the card assets to the same Web release; no additional `web.mjs` forwarding file is needed.

Windows `.cmd` / `.bat` launchers receive a fixed English pickup instruction. The original message stays in the delivery's existing private UTF-8 prompt file; only its path is supplied through that child's `RABIROUTE_COPILOT_PROMPT_FILE` environment variable. Copilot reads that file to perform the original task, so quotes, newlines and command characters in a message are not interpreted by cmd. Native executables continue to receive independent arguments. User-managed `COPILOT_CLI_ARGS`, working directories and sessions remain available. Custom arguments that omit `{prompt}` retain stdin mode; a script launcher's stdin likewise receives only the fixed pickup instruction.

See the [Agent integration requirements](../../../../docs/agent-adapter-standard-requirements_en.md) for configuration switching and shared-task dependencies, and the [SDK](../../../contracts/plugin-sdk/README_en.md) for lifecycle contracts.

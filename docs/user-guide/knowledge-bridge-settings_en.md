# Using knowledge services after connecting

English | [简体中文](knowledge-bridge-settings.md)

Connect the application in RabiLink settings and select an online PC to use its knowledge tools. Authenticated devices in the same application can read and write by default, without an MCP address, knowledge secret, role/tool allowlists or device-grant JSON.

The speech address remains an advanced connection parameter: it chooses a local service rather than adding another permission. For offline devices, incompatible versions or stopped services, inspect the corresponding status. Re-entering grants cannot repair service availability. Revoked credentials or rebinding prevent requests from continuing under stale identity.

When a write is uncertain, preserve its original operation key and query the receipt without automatic replay. Application connection, service readiness and successful business writes are separate results. The old permission form is removed; configuration normalization/saving removes its retired fields while preserving other settings and data. Both PC and Relay need updates for the unified behavior.

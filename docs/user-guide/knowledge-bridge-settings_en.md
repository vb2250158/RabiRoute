# Local knowledge bridge security settings

English | [简体中文](knowledge-bridge-settings.md)

Expand **Local knowledge MCP security settings** in RabiLink's PC settings and load the current configuration. Enter the existing local MCP address, role/tool allowlists and device ownership grants. This uses the existing local or authenticated remote WebGUI management boundary, not the generic device proxy. It neither starts a service nor executes knowledge operations.

The password field is write-only. Leave it blank to retain an existing secret; masks are rejected. Never put the local connection secret into a device profile or Relay configuration. Writes are disabled by default; recent-memory detail reads that update viewed state also require write permission.

Saving PATCHes only `rabiLinkRelay.knowledgeBridge`, preserving unrelated settings, and checks authoritative readback. Uncertain outcomes block another save until manual inspection. The existing identity API has no revision CAS, so concurrent-administrator safety is not claimed. Refresh overwrites unsaved edits. A secret can only be confirmed by a successful PATCH plus configured status, not by plaintext readback. Refresh after a timeout does not prove that this particular secret update committed.

Saved configuration and connection readiness are separate. Refresh reads actual runtime `knowledgeBridgeReady` and capabilities. Readiness indicates a successful preflight, not a completed tool call. Relay device grants, local PC grants and MCP server policy must all permit the operation. Local testing/build evidence does not mean installation or real-device acceptance.

English | [简体中文](agent-call-history.md)

# Agent call history

Open the Call history tab in Logs & diagnostics. Runtime logs shows the current Route’s latest 30 output lines. See [operations and troubleshooting](user-guide/operations-and-troubleshooting_en.md#inspect-agent-call-history) for user steps.

## Capture and correlation

Manager observes the original HTTP reader and writer, reuses request IDs and resolves operationId from the registered operation. Rabi CLI and MCP share client capture for transport observations and final tool results. They send x-rabiroute-call-id, x-rabiroute-call-source and x-rabiroute-tool-name correlation headers. Agent type and session use existing metadata. Source is caller-reported metadata.

A callId correlates phases. The phase key contains callId, spanId and boundary, with server, client or tool boundaries. Duplicate client receipts preserve the first durable content and increment a conflict counter when content differs. Server stages update from running to completion. Business results, execution count, cancellation signals and execution ownership retain their existing contracts.

## API

| operationId | HTTP | Purpose |
| --- | --- | --- |
| manager.calls.list | GET /api/diagnostics/calls | Indexed pages and capture settings |
| manager.calls.read | GET /api/diagnostics/calls/:callId | Stage directory, or one payload using spanId and boundary |
| manager.calls.client.observe | POST /api/diagnostics/calls/client | Durable client observations |
| manager.calls.config.save | PUT /api/diagnostics/calls/config | Capture switches and size limit |
| manager.calls.events | GET /api/diagnostics/calls/events | Coalesced change notifications and heartbeat |

List filters include source, status, sessionId, query, from and to. query matches operations, tools, paths and call IDs. limit defaults to 50 with a maximum of 200. Cursors bind filters and the first-page sequence watermark. Listing reads the index. Payloads load on demand.

Configuration contains enabled, captureBodies and maxBodyBytes. Defaults are true, true and 4194304. The size range is 1024 through 16777216 bytes. History is retained with no automatic archival or deletion in this version. Date-based gzip directories provide physical partitioning.

## Failures and completeness

Payloads are redacted before persistence. Truncated JSON that cannot be reliably redacted is omitted. Binary data retains metadata. captureState, truncated and the business code distinguish capture completeness from business results. The bounded storage queue persists drop and conflict counters. Unacknowledged client observations remain in an outbox partitioned by the verified Manager target and upload after that target recovers. Invalid entries are isolated and removal follows durable acknowledgment.

Client flushes process at most 16 entries within a default total budget of 1500ms. Uploading observations preserves original business execution. History endpoints, their event streams and metadata probes are excluded from capture. History starts with captured requests after activation. Ordinary shell commands and other MCP servers depend on host integration.

## Verification

Run src/manager/agentCallHistory.test.ts, apps/rabi-agent/test/call-observation.test.mjs, apps/rabi-agent/test/manager-cli.test.mjs and apps/rabi-mcp/test/knowledge-mcp-server.test.mjs. The call-history scenario in scripts/api-contract-built-manager.test.mjs exercises an isolated compiled process, port and state directory.

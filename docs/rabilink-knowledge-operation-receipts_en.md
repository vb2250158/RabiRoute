<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-knowledge-operation-receipts.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Retired knowledge integration

The old knowledge bridge, intent queue, per-tool grants and phone grant editor are retired. This page preserves a documentation link; it does not describe a supported runtime or configuration path. Old business configuration is not migrated.

Use the target PC's [Manager interfaces](rabi-agent-interfaces_en.md) through the [generic API transport](../apps/rabilink-aiui/docs/generic-api-transport_en.md). Enabled authenticated Agents have the same API access as local callers, without workspace, persona or Route grants. Bindings only select automatic delivery targets. Relay handles connections, authentication and opaque transport.

Knowledge, persona, Skill and message state remain on the owning PC. Preserve each endpoint's actual revision, identity and receipt contract. For uncertain writes, read back the original resource or receipt; do not change the key or replay the write automatically.

See [AIUI acceptance](aiui-agent-acceptance_en.md) and [Relay deployment](rabilink-relay-server_en.md) for current implementation and outstanding checks. No old knowledge URL, MCP secret or permission form is required.

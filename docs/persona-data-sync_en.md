<!-- docs-language-switch -->
<div align="center">
English | <a href="./persona-data-sync.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Multi-PC persona data synchronization (retired)

> Status: persona data synchronization is retired in source. This page preserves the former documentation entry and data-retention boundary; it is not evidence of deployment or comprehensive remote-feature acceptance.

## Removed capabilities

RabiRoute no longer provides automatic or manual persona-folder synchronization, synchronization previews, file merging, a conflict-resolution workspace, or synchronization APIs. The former `/api/persona-sync/*` and Relay `/api/rabilink/persona-sync/proxy` paths are no longer supported contracts. AgentPacket no longer injects persona-sync instructions. Do not call the retired endpoints, run the old synchronization acceptance commands, or create background synchronization tasks.

## Use existing RabiLink remote access

To use a persona on another PC, access that PC's persona, Agent, and data through the existing RabiLink connection. Do not copy the remote persona into a local replica or create a second source of truth. The target PC retains ownership of its persona and data; remote requests still follow existing authentication, authorization, capability allowlists, and mutation-receipt boundaries.

Retiring synchronization does not remove discovery, generic LAN/P2P/Relay connections, remote Agents, remote WebGUI, or speech capabilities. See [Cross-PC API calls](rabilink-peer-rpc_en.md), [Generic cross-PC connections](rabilink-peer-tunnel_en.md), and [RabiLink Relay](rabilink-relay-server_en.md) for available contracts and limits. Remote access is not synchronization and does not imply that every local capability has passed remote acceptance.

## Retained historical data

- Preserve existing personas, plans, memories, identity relations, conversations, and other business data. Removing synchronization does not delete them.
- Keep historical archives, conflicts, resolution records, indexes, pending-state records, and acceptance evidence under `data/persona-sync/` unchanged. Do not automatically delete, migrate, replay, or restart synchronization from them.
- Preserve historical plans and task records. An old synchronization objective is not authorization to continue synchronization.
- If an already-started legacy transaction must recover to preserve plan-package or storage consistency, recovery handles only that existing local transaction. It starts no peer reconciliation, file replication, or synchronization API and does not mean synchronization remains available.

This page describes the retired source contract and data-retention boundary only. Builds, installation, deployment, and real cross-PC acceptance require separate evidence.

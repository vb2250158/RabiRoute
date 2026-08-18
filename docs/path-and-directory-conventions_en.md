<!-- docs-language-switch -->
<div align="center">
English | <a href="./path-and-directory-conventions.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Path and Directory Conventions

> Audience: integration developers and project maintainers. This page defines where software belongs, where runtime data belongs, and which path forms interfaces may accept.

## Software directories

| Directory | Owns | Must not own |
| --- | --- | --- |
| `src/adapters/` | Inbound protocol parsing and normalization | Routing decisions, Agent prompts, Manager page APIs |
| `src/agentAdapters/` | Delivery to the Agent or program that performs the work | Message-platform protocols |
| `src/messageEndpoints/` | Manager-owned endpoint scans, login, and process operations | Routing core |
| `src/routing/` | Route decisions and AgentPacket assembly | File persistence and client UI |
| `src/messageProcessing/` | Requirement state machine, record verification, Manager client, and persistence adapter | Manager HTTP routes and platform protocols |
| `src/manager/` | Manager control plane, operational logs, and constrained APIs | Protocol logic independently owned by a Gateway |
| `src/shared/` | Ownership-free rules shared by several modules | A feature-specific state machine |
| `ribiwebgui/` | Browser UI | Manager or Gateway source of truth |
| `apps/` | Independently built and released clients | Copyable samples and Manager-private data |
| `packages/` | Stable contracts and SDKs reused by several applications | Services that own product runtime state |
| `examples/` | Public, copyable, sanitized samples | Real accounts, group IDs, chat content, tokens, or host absolute paths |

Feature tests normally live beside the TypeScript source under the same module. Cross-module acceptance scripts belong under `scripts/`; root-level temporary files are not test entry points.

## Data directories

| Path | Data class | Committed |
| --- | --- | --- |
| `examples/data/` | Complete public sample data pack | Yes, with placeholders and sanitization |
| `data/route/` | Local configuration and runtime data for each Route | No |
| `data/roles/` | Persona files, plans, memory, conversation records, and persona attachments | No |
| `data/.runtime/` | Internal Manager state needed for recovery or reconstruction | No |
| `data/.runtime/performance/` | Hourly local performance JSONL managed by retention and disk limits | No |
| `data/.runtime/imports/` | Time-bounded import staging | No; remove after completion or expiry |
| `logs/manager/` | Structured Manager operational logs | No; diagnostic evidence, not a business source of truth |

Code obtains project-level locations through `src/shared/projectDirectoryLayout.ts` instead of rebuilding fixed paths such as `data/.runtime` or `logs/manager` in each module. Route data and persona data use separate `routeDataDir` and `personaDataDir` fields. Internal modules must not reuse an ambiguous `dataDir` for both. Legacy configuration may still read `dataDir`, but the configuration boundary converts it into the explicit fields.

## Path interfaces

- Public APIs and durable contracts use typed references instead of one string that may be either a business ID or a file path. A project-fact record, for example, carries a `planId`, `memoryId`, or project-relative `relativePath`.
- User-selected project files must be relative to a declared root. Absolute paths, `..` traversal, and symlink or junction escapes are rejected.
- Internal code that needs an absolute path resolves and validates it through `src/shared/pathPolicy.ts` before filesystem access.
- Ordinary project-path conversion does not guess a previous workspace. Explicitly named compatibility migration functions are used only while reading legacy persisted values; new values remain interpretable by the current project.
- Browser and external-handler APIs do not expose host absolute paths unless the operation itself explicitly opens a local file.

## Lifecycle and ownership

- `examples/` is part of the software distribution. `data/`, `logs/`, and import staging are local data. Copy, packaging, and submission workflows keep them separate.
- State machines own business rules; persistence adapters own JSON file I/O. `src/messageProcessing/board.ts` does not choose a file location, while `src/messageProcessing/persistence.ts` owns the runtime state file.
- Logs may be rotated or deleted. Plans, memory, message records, and delivery receipts have separate data contracts and are not temporary merely because they live under `data/`.
- Determine the owner of unknown root files and tool-generated directories before moving or deleting them. Do not include them in a public submission without confirmation.

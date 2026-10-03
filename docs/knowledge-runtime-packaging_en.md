# Knowledge runtime packaging closure

English | [简体中文](knowledge-runtime-packaging.md)

This page describes the 0.3.22 release layout and closure checks. Passing scripts and guard tests does not establish installation, Host health or physical-device business acceptance.

## PC packages and developer candidates

The stable knowledge implementation lives in `packages/rabi-knowledge-contract/{schema,tools,receipt}.mjs`. Manager's `rabiLinkKnowledgeDirect` calls existing Manager knowledge APIs and reuses tool mapping and receipt validation, without starting an external MCP service or configuring a knowledge URL or secret. Imports from compiled `dist/manager/` resolve to `packages/rabi-knowledge-contract/` at the installation root. TypeScript does not copy these files.

Windows release explicitly requires the three shared modules and the thin `apps/rabi-mcp/lib/{knowledge-tools,knowledge-receipt}.mjs` wrappers, failing on missing source. The independent MCP application reuses the same implementation; wrappers must not retain duplicated legacy tool logic. Root production dependencies use locked `npm ci --omit=dev --ignore-scripts`; dependency installation does not start an MCP service.

Developer candidates also verify and overwrite these five files. An existing independent MCP application receives updated wrappers. When the base lacks that application, the shared files and wrappers still form an importable closure without creating an otherwise absent caller. The base remains unchanged, and missing source fails before staging.

## Relay layout and migration

`scripts/rabilink-relay-runtime-files.json` contains repository-relative paths for the entry and recursive static relative dependencies. It includes runtime modules under `scripts/`, helpers under `scripts/lib/`, and the three shared contract modules. Knowledge authentication uses `scripts/rabilink-knowledge-access.mjs`; the grant and grant-UI modules are retired.

The manifest drives staging, backups and post-extraction missing-file checks. Archives preserve `scripts/`, `scripts/lib/` and `packages/rabi-knowledge-contract/`. The entry is `node scripts/rabilink-relay-server.mjs`, rather than a flattened root module. Deployment backs up the legacy flat manifest and known historical files, installs the new layout, removes the backed-up flat entries and grant modules, and records the migration. Configuration and business data remain intact. Remote installation recursively copies the reviewed staged archive.

## Provenance and checks

The generic Windows `Copy-TrackedTree` includes tracked files only. The five knowledge modules, release-list validation helper and reviewed Relay manifest entries are explicit required exceptions. Snapshots without Git may use a `-TrackedFilesManifest` of paths and hashes. Only this stable shared-module set is accepted; it does not permit arbitrary packages, untracked files or runtime data, and hashes do not establish provenance authorization.

The Chinese/English contracts for device profile HTTP, knowledge-operation receipts and legacy phone-page migration are required documents. Linked targets are not copied recursively; consult the source repository for the full index.

Run `node --test scripts/runtime-package-closure.test.mjs scripts/developer-channel.test.mjs scripts/windows-release-optional-speech.test.mjs` to check static closure, actual candidate-wrapper imports, base protection, missing-source rejection and release-path limits. Scripts accessing Manager also run `node --test scripts/dynamic-manager-active-truth.test.mjs`. New or dynamic runtime dependencies require manifest and check updates. Complete-package startup, installation-directory imports, managed Host health and dual-device business acceptance each require their own evidence.

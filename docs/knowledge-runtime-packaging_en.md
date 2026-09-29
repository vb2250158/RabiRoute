# Knowledge runtime packaging closure

English | [简体中文](knowledge-runtime-packaging.md)

This records release-script fixes and local guard tests, not installation or deployment acceptance.

Compiled `dist/manager/rabiLinkKnowledgeRuntime.js` retains the import `../../packages/rabi-knowledge-contract/schema.mjs`, resolving to `packages/rabi-knowledge-contract/schema.mjs` at the installation root, not `dist/packages`. TypeScript does not copy it. Windows release explicitly copies this required runtime file and fails if missing, independently of Git tracking, without copying arbitrary packages. The official MCP SDK is a root production dependency installed into the payload through locked `npm ci --omit=dev --ignore-scripts`.

Relay deployment uses `scripts/rabilink-relay-runtime-files.json` for its entry and recursive static relative dependencies. The same list drives local staging, remote backup and post-extraction missing-file validation before runtime files are copied. Backup preserves `lib/` paths. Remote installation already recursively copies the entire staged archive; the former explicit list only governed backup.

Run `node --test scripts/runtime-package-closure.test.mjs` to verify the actual static import closure and Windows schema/SDK contract. New or dynamic runtime imports require updating the manifest and guards. This test does not replace isolated full-package startup, imports from an installation directory, real Host health or device acceptance.

The generic Windows `Copy-TrackedTree` still includes tracked files only. New uncommitted scripts do not automatically enter that collection. Explicit required exceptions include the knowledge schema, release-list validation helper, and each reviewed Relay runtime module, preventing a tracked entry from shipping without new dependencies. The six Chinese/English contracts for device profile HTTP, knowledge-operation receipts and phone knowledge permissions are explicit required documents. Linked targets are not recursively included without review; consult the source repository for the full documentation index. Local snapshots without Git may use an audited `-TrackedFilesManifest` of paths and hashes. This does not authenticate provenance or permit indiscriminate copying of untracked files or runtime data.

English | [简体中文](persona-skill-api-contracts.md)

# Executable contracts for persona Skills

Skill lists, documents and complete ZIP downloads share executable definitions for HTTP dispatch and remote discovery. Original interactive read workers still own catalog reads and archive generation. Bundled scripts are never executed.

| Operation ID suffix | Method | Persona path | Prefixes |
| --- | --- | --- | --- |
| `list` | GET | `/:roleId/skills` | `/api/roles` and `/roles` |
| `detail` | GET | `/:roleId/skills/:skillId` | `/api/roles` and `/roles` |
| `download` | GET | `/:roleId/skills/:skillId/download` | `/api/roles` and `/roles` |

There are six concrete routes. Full IDs start with `manager.personas.skills.`; `/roles` IDs add `.alias`. Original derived `knowledge` and `knowledge-alias` IDs remain aliases. Authenticated empty nodes can read another persona’s public Skills without a Route, persona binding or additional feature grant.

## Native ZIP and lease ownership

Downloads retain portable path validation, metadata-ID selection, conflict/source-change checks and all native archive limits: 16 MiB per file, 64 MiB total source bytes, 4096 entries, depth 32 and a 68 MiB ZIP. Links, unsafe names, duplicate IDs and existing output replacement remain rejected. Reading SKILL.md does not establish a complete directory download.

Each download retains a private temporary directory. Native admission allows at most four active leases, including generation, slow transfers and workers whose exit is unconfirmed. Transfer timeout defaults to 30 seconds. ZIP files retain O_NOFOLLOW, regular-file/nlink=1/length checks, Content-Length, download names, SHA-256 and ETag.

Frames are bounded to 64 KiB. EOF, disconnect, timeout and cancellation close and join the original file stream, then remove the private directory and release admission. Explicit cancel also cleans an iterator that has never started. Receiving the final Content-Length bytes does not establish that server-side directory cleanup has completed; actual lease release is authoritative.

`termination_unconfirmed` preserves the native pool’s quarantined slot and private directory until the original `onWorkerReleased` callback confirms exit. Failed cleanup retains admission and uses the original error-reporting callback, preventing unbounded orphan artifacts.

Each request resolves the current persona directory and rechecks the original connection, directory and Manager identity after worker/file awaits and between frames. A changed owner cannot expose the previous ZIP. Downloads reject query parameters. Generic decoding returns 400 for malformed percent encoding; the existing remote ingress guard still rejects unsafe paths under its original contract without resolving a persona or creating a temporary directory.

## Verification and scope

Isolated tests cover all six routes, actual empty-node authentication, native catalog/content/ZIP bytes and hashes, real worker and CLI downloads using `--agent-type` plus a complete `--id`, archive boundaries, disconnect/slow-transfer cleanup, unstarted-iterator cancellation, directory/generation changes, unconfirmed-exit quarantine and retained admission after cleanup failure. Tests use temporary Skill data and run no real script or Agent prompt. They do not establish installed-runtime or physical-device acceptance.

Other persona APIs retain their owner migration boundaries and corresponding legacy prefix dispatch until complete.

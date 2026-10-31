<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.desktop-pet

This built-in Manager plugin reuses original persona assets, desktop settings, catalog workers and motion receipts, and provides `manager.desktop-pet@1`. It does not start a replacement pet runtime inside Manager.

`DesktopPetOwner` and `createDesktopPetOperations` install twelve public HTTP operations from executable contracts. Every path starts with `/api/desktop-pet/roles/:roleId`; every operation ID starts with `manager.desktop-pet.`:

| ID suffix | Method and path suffix | Result |
| --- | --- | --- |
| `binding.read` | GET empty suffix | Original persona binding and defaults |
| `binding.patch` | PATCH empty suffix | Merge and persist binding |
| `binding.put` | PUT empty suffix | Preserve native merge semantics |
| `dialogue.read` | GET `/dialogue` | Persona dialogue text |
| `transcripts.append` | POST `/transcripts` | Persist playback text with matching persona, voice and tts kind |
| `packs.list` | GET `/packs` | Native catalog; `scope=runtime` selects runtime cache only |
| `packs.import` | POST `/packs/import` | Import original GIF, PNG or ZIP bytes and populate runtime cache |
| `packs.cache` | POST `/packs/:packId/cache` | Promote a validated shared pack into immutable runtime cache |
| `assets.read` | GET `/packs/:packId/assets/:assetPath` | Original GIF/PNG bytes |
| `motion.submit` | POST `/motion` | Accept a motion request and return its native receipt |
| `motion.receipt` | GET `/motion/:requestId` | Read a receipt from this Manager generation |
| `motion.runtime` | POST `/motion/runtime` | Claim native renderer work or acknowledge it using the original claim token |

Assets retain relative paths, realpath containment, cache preference and shared-source fallback. Only finite GIF/PNG files are returned, without JSON/base64 wrapping or new SSE/WebSocket endpoints. The asset limit is 64 MiB; binding/transcript JSON is 64 KiB, motion JSON is 8 KiB and raw imports are 128 MiB. Original expanded-archive size, entry, script and path rules remain enforced by the native importer.

Settings writes retain shared normalization and mutation audit. Native owners retain import, immutable cache promotion and transcript identity. Authenticated remote connections use the same public contracts and explicit user disables, without another persona or local-origin grant. Motion submission requires `Idempotency-Key=requestId` and identical content for identity reuse. Public receipts exclude renderer tokens. Runtime acknowledgments still require the matching original claim token; success additionally requires verified arrival. HTTP 202 and running are not completion.

Catalog reads use the original Manager worker pool. Response timeout and actual worker release are tracked separately. Retirement stops admission, joins accepted operations including bodies still being consumed, then joins original worker releases. Disconnecting does not forget or automatically replay file effects. Motion receipts retain their original settings-object and Manager-generation scope, capacity, timeout and one-hour terminal retention; they are not durable across restarts.

Isolated tests establish contract, file, receipt and asset behavior only. They do not start a real pet or establish desktop movement, rendering, speech or physical-device acceptance.

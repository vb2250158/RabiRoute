English | [简体中文](persona-recording-api-contracts.md)

# Role all-day recording API contracts

Status: 24 concrete operations use executable registration. Isolated storage, controlled capture dependencies and HTTP regressions do not establish acceptance of real microphones, cameras, NAS, phones or all-day endurance. See [role all-day recording](persona-all-day-recording_en.md) for usage and storage details.

The base paths are `/api/roles/:roleId/all-day-recording` and the existing compatibility path `/roles/:roleId/all-day-recording`. Both use the same native owner. Each base has 12 operations:

| Method | Suffix | Original execution and result |
| --- | --- | --- |
| GET | Empty | Native service state, settings and discovered phone sources |
| GET | `/recent`, `/catalog` | Bounded recent projection, date catalog and loading/incomplete metadata; catalog retains day, refresh=1 and summary=1 |
| GET | `/page` | Original `(startedAt,id)` bidirectional cursor, source/type filters and page size 100 |
| GET | `/transcripts`, `/events` | Original 26-hour range, source timestamps, read coverage and transcript filtering |
| PUT | `/settings` | Original validation, atomic write, serialized control queue and state readback |
| POST | `/start`, `/stop` | Original sole Host capture owner and same-role native idempotency |
| POST | `/index-repair/:day` | Original bounded derived-index job; queued acknowledgement does not mean reconstruction completed |
| GET | `/media/:day/:file` | Controlled role/computer JPEG/WAV; file is a 64-character lowercase hash plus extension |
| GET | `/audio` | First check the visible timeline event, then its phone owner/chunks or original speech record; preserve upstream status, MIME and bytes |

Preparation in `createPersonaRecordingOperations` captures the original connection, Manager identity, role directory and runtime/service/store/read model. Authenticated enabled remote connections have default public access without context-based feature grants. Existing local-origin and read-only checks remain. Settings retain the original unlimited application byte setting, empty-body `{}` and native validation. Controls still require `application/json`; start/stop/repair ignore the body instead of requiring new fields.

`AllDayRecordingService` still serializes controls and rechecks authority in its native queues, storage and speech boundaries. HTTP cancellation waits for accepted native work to reach its terminal state; it does not prove capture has stopped. Phone resource owners come from original events. Query values cannot impersonate sources or bypass selected devices. Original read workers, the 60-second history budget, independent reconstruction queue and durable-record retention remain unchanged.

Settings and derived caches distinguish the complete original directory. New requests after a root change do not reuse the old cache, and old asynchronous projections cannot publish as current results. Reconstruction captures its original directory and rechecks it when entering the queue and after loading settings. Runtime disposal joins accepted reconstruction work; migration does not delete raw events. HTTP queued, loading and actual worker exit remain distinct facts. After a write failure or identity change, inspect original settings, session and events rather than automatically repeating capture across generations.

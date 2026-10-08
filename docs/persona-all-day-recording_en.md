English | [简体中文](persona-all-day-recording.md)

# Persona all-day recording

Event lists use the `(startedAt,id)` cursor through `GET /page?direction=older|newer&time=milliseconds&id=eventId&source=source&type=all|asr|image|window|status|device`. Pages contain at most 100 events and a directional `hasMore` flag. Traversal crosses empty dates until the actual boundary. Entry reads all available day indexes and retains every loaded event for direct selection through virtual scrolling, without the previous 2000-event trim. Originals are not deleted. Day indexes are still read per day; initial reconstruction and sparse filters are not constant-time operations.

Audio is saved under a stable event ID before transcription completes; subsequent states update that event. Mobile and PC use `pending/processing/ready/empty/error`, independently of media persistence. Local-only mobile recordings remain local. New data never forces historical browsing back to live.

Status: newly implemented; build, installation and physical-device acceptance must be checked separately.

Open **Persona → All-day recording** to review a continuous timeline and events, matching the mobile fixed cursor, drag, inertial scrolling and cross-date navigation. The default window is 30 minutes, with an edge-to-edge zoom span from 3 seconds to 24 hours. Dates provide jumps; Live follows the current clock. Microphone recording reuses RabiSpeech segmentation and ASR. Screen and camera save periodic JPEG frames; foreground-window events record title changes observed at those samples. This is not continuous screen video and does not infer user activity from an open window. Empty periods remain empty and capture failures are explicit.

Computer capture and Home Assistant sources default off; first enabling requires at least one selected source. Host-local enable intent survives application shutdown and restores the owning persona on startup; explicitly disabling clears it. One host has one recording persona, with other personas showing the conflict. Save device changes while running; they apply after the bounded in-flight sample completes. Disconnected microphone streams retry at the sampling interval. Screen and camera sampling are isolated so one failure does not discard the other results. Cameras still use their configured index; OS index reordering requires reconfirmation and does not preserve physical device identity.

Recording settings include a **Home Assistant** switch that can be enabled alone. It subscribes directly to the `logbook/event_stream` used by Home Assistant Activity, including vacuum progress, ordinary states and custom entries, preserving source timestamps, entities, state text and stable deduplication IDs. Connect Home Assistant in Xiaomi Home settings; Agent event monitoring, its significant/all policy and persona binding do not control recording. Save settings and enable recording to import existing activity from the current local day and continue receiving live events. Pausing or disabling this source disconnects its subscription. Reconnecting or re-enabling backfills and deduplicates the current local day, capped at the last 24 hours, without importing earlier dates. Events appear in the timeline, source filter and **Device events** filter. Missing connections, rejected authorization and failed Activity subscriptions surface source errors without blocking other capture sources. Home Assistant alone does not call speech or frame capture services. Agent notifications and camera event clips remain independent.

Device records retain activity entities, display names, state text and source timestamps. IDs derive from activity time, entity, state or message, and context, so retries do not duplicate an activity. Older settings without `homeAssistant` load with it off and are upgraded through the normal save path; remove that compatibility conversion only after existing settings have migrated. Events use the same computer storage, indexes and SSE updates. This source does not download clips, execute device actions or automatically notify an Agent.

An existing local microphone session is shared, collecting only computer recordings since enrollment. Disabling or lease expiry leaves that listener running. If no listener exists, a temporary session is started and restored on release. Remote input is rejected; source or session changes are explicit errors. Existing ASR thresholds and message routing still apply. Sound that never meets recording/transcription thresholds is not a saved event.

After transcription, the updated phone app exports event timestamps, text and playable WAV through the authenticated resources channel to the computer that processed that event. A durable queue is separate from ASR acknowledgement, so network failures or an older PC cannot block transcription. Account and target are frozen at enrollment. Each persona explicitly selects which discovered phones to include; request bodies cannot impersonate another authenticated source. This covers new transcription events after the update, not automatic historical backfill inferred from old receipts, unuploaded phone videos, or health data.

Screen sampling and F1 share `rabiroute_tray.desktop_capture.capture_desktop_pixels()` for native pixels across all monitors. All-day recording only resizes and saves JPEG frames, without loading Qt, opening selection UI or changing the clipboard. F1 retains selection, multi-monitor coordinate mapping and interaction.

The preview sticks below the top navigation as the page scrolls. The timeline scrolls with the page, while the event list scrolls independently. Scrubbing positions the list; scrolling the list updates the center time and reviewed event. Both timeline markers and list cards are clickable and do not start a drag. The list uses buffered events and preserves its visible anchor on refresh; programmatic positioning does not feed back into timeline navigation.

Screen previews fit the complete virtual desktop without cropping, preserving the relative monitor positions, proportions and gaps from Windows display settings, including monitors below the main display.

## Storage and lifecycle

- Computer settings and events live under the persona's `all-day-recording/<host-hash>/`, separated by host. Settings contain no persisted running intent.
- Events are divided into UTC date directories by `startedAt`, with one stable identity-hash file per event. The page reads complete day indexes, merges incremental events and fills missing indexes by day in the background across UTC shards; each request is limited to 26 hours. Physical partitioning is not memory consolidation or deletion.
- JPEG/WAV files are written before event commit. Computer audio is copied into recording storage instead of depending on expiring speech caches. Phone audio uses ResourceCache and requires verified SHA-256/durable receipts for every block before event commit.
- The receiving PC owns `data/mobile-recording-events/`. Authenticated source plus stable event ID makes retries idempotent. Writes are serialized and use fsync plus atomic replacement. These records are not automatically replicated to other PCs/personas.
- Original recordings are not automatically deleted; only temporary atomic-write files are removed. Storage exhaustion, unavailable speech services and capture-device failures remain explicit.
- Users and local Agents may query the timeline. It does not automatically notify an Agent or inject raw recordings into prompts.

## Local API

Discover the current Manager URL through Host and verify `/meta`. These endpoints are local-host only, reject device tunnels, preserve Manager authorization/read-only restrictions, and accept no arbitrary paths or commands.

Base: `/api/roles/:roleId/all-day-recording`. JSON success: `{code:0,data:...}`; failure: `{code:-1,message:...}`.

| Method/path | Contract |
| --- | --- |
| `GET /` | Settings, actual session state, last sample, errors and discovered mobile sources |
| `PUT /settings` | Boolean `sources:{microphone,screen,window,camera,homeAssistant}`; `intervalSeconds` 10–3600; `cameraIndex` 0–16; `mobileDeviceIds` from discovered source hashes. Changes can be saved while recording |
| `POST /start` | Start saved sources; retry for the same active persona returns status; another owner fails |
| `POST /stop` | Drain the bounded in-flight sample and stop this session; repeated stop is a no-op |
| `GET /catalog` | Lightweight `days`, recent events and known `incompleteDays`, without waiting for full history |
| `GET /catalog?day=YYYY-MM-DD` | One day's available indexed events and completeness; no raw-event scans or day-write-lock wait |
| `GET /recent` | Current host and selected phones' recent snapshots, independent of history reconstruction |
| `GET /events?since=...&until=...` | Millisecond range, at most 26 hours; events ordered by source time |
| `GET /media/:day/:hash.jpg` or `.wav` | Read current persona/host media only |
| `GET /audio?since=...&until=...&id=...` | Verify event membership in the visible persona timeline before reading phone resources or speech audio |

Settings/start/stop use a single Manager serial queue. Start/stop are session-idempotent; after uncertain results, GET status rather than replaying across generations. Snapshot subprocess timeout is 15 seconds, speech API timeout 30 seconds. UI refresh uses `all_day_recording` SSE, not business-state polling.

Phone `PUT /api/resource-cache/data/recording-events` requires an authenticated resources tunnel. Body: `{id,startedAt,endedAt,text,chunks}`; timestamps are milliseconds, text at most 100000 characters, at most sixteen 1 MiB content-hash blocks. Every block must already belong to the authenticated source and pass integrity checks. Success is `{durable:true}`. Source/event identity makes retries idempotent. HTTP 400 is invalid data/resources, 403 authorization/read-only, and 404 an older PC without this endpoint. The phone later retries the same frozen queue item.

The list renders at most 24 nearby rows. Dense events from the same source are grouped into 0.5% timeline buckets; clicking selects an event and zooms in. Background refreshes coalesce into one pending request without cancelling an active read. Hidden pages defer automatic refresh until visible. Existing content and the browsing anchor survive refresh. A 100,000-event synthetic frontend test is not a NAS throughput benchmark.

Entry displays the persona preview immediately and reads the full indexed catalog, recent events and capture state independently. `GET /catalog` first returns a lightweight date directory and recent events. The page reads up to four `GET /catalog?day=YYYY-MM-DD` requests concurrently, newest first, merging each response immediately without waiting for the entire history. These reads never scan originals or wait for day write locks. `incompleteDays` identifies history requiring background reconstruction; displayed events remain selectable. A first installation without indexes still needs reconstruction and is not presented as complete history. `GET /recent` bypasses day-index reconstruction and returns up to 128 events each from the computer and selected mobile sources. The rebuildable `recent-preview.json` snapshot deduplicates stable IDs and sorts by `startedAt`; original-event commits and successful day reconstruction update it atomically. It survives restart. Older installations without this snapshot populate it on the next capture or history read. Originals are neither moved nor deleted.

The browser stores the complete event metadata preview per persona in IndexedDB, valid for reads for 24 hours. Tab memory retains at most four personas. A separate localStorage preview fits within five million serialized characters, falling back to the latest 200 events for immediate first paint when necessary; IndexedDB independently restores the complete list. If cache restoration fails, server history loads progressively by day. New tabs display cached events with an updating indicator. The cache does not establish capture status. History, status and images load independently; new events can refresh while a history request is pending. The 24-hour limit applies only to display cache validity, not original-record retention. The live clock never triggers history reads; SSE only merges recent events and reads capture state while preserving history and selection. Failures settle with a retry message; explicit refresh reloads the catalog. Read/image deadlines are 12 seconds; control mutations have 45 seconds and are never replayed automatically. Browser cache database waits are bounded to four seconds and never block server reads or event selection.

`events-index/YYYY-MM-DD.json` is a rebuildable day index maintained by the current Host's write owner. A durable `.dirty.json` marker precedes each original write and is removed only after both original and index commit. Interrupted, missing or damaged indexes rebuild in batches of at most 16 originals. Writes and reconstruction serialize per day, with stable IDs for retry deduplication; initial reconstruction can briefly delay new sample persistence for that day. Valid indexes neither depend on NAS directory timestamps nor enumerate originals. Out-of-owner file edits are outside this protocol; operational restoration must also invalidate the corresponding index.

Concurrent reads for a day coalesce; successful results cache for five seconds, bounded to eight days and 20,000 events per day. Successful owner writes invalidate the memory cache, and failures are not cached. Indexes and caches are reconstructible, never move or delete originals, and do not use archival 24/72-hour windows. Initial index reconstruction still grows with the number of files in a day. A day index does not implement server-side cursor pagination.

## Wide review layout

Entry selects the latest screenshot, falling back to the latest non-status event. Status and events load independently; restored tab data displays immediately and cache persistence is deferred. An interval index preserves overlapping long audio without scanning the entire buffer during navigation. Rapid navigation defers image reads by 150 milliseconds; superseded requests are cancelled and cannot overwrite newer selections. Images decode asynchronously before replacing the previous frame. The page caches at most four images totaling 16 MiB, released on exit. Audio loads on playback; transcripts initially render 600 characters with expansion on demand (event responses still contain the full text).

At widths of 1000px or more, the preview and timeline occupy a sticky left column (about 60%); independently scrolling events occupy the right column (about 40%), matching the overall height of the left column. Event count, source filtering and refresh sit between the page title and recording switch and wrap when needed. Narrow windows stack the panels. Events are newest first. Timeline navigation positions the list, list scrolling positions time, and refresh preserves the browsing anchor.


ASR review events appear only after successful transcription produces non-blank text. Raw audio remains saved but is hidden from the event list and historical timeline. Events keep their original capture time and identity, not the transcription completion time. Filters, pagination and previous/next navigation skip hidden audio before counting a page. Mobile live mode retains the microphone waveform. The mobile date/live/refresh toolbar includes previous/next event controls, and event type (ASR/video) is independent of device source.

Previous/next navigation selects immediately within a complete, untrimmed loaded range. Outside that range it loads a page asynchronously with a loading indicator and bounded wait. Events sharing a capture timestamp remain distinct and are traversed by stable ID.

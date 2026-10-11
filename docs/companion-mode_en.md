[English](companion-mode_en.md) | [简体中文](companion-mode.md)

# Desktop-pet companion mode

Companion comments use the [shared desktop pet bubble and speech presentation](desktop-pet-bubbles_en.md). Text follows playback and fades after its display lease. Ordinary persona speech shares the same customizable bubble, without collapse or replay buttons.

Status: experimental first release. Right-click the Windows desktop pet and toggle **Companion mode**; click again to end it. No game, streaming site, activity category or window selection is required.

The pet follows the foreground window and sends its current frame, title and process name to this persona's enabled local Agent Route. The Agent classifies the activity as playing, watching, other or uncertain. It stays quiet during focused work or uncertain observations, discusses only visible story content without looking up future plot, and observes games without controlling them. Classification can be returned without speech. Reduced frames are delivered as actual image attachments. The local attachment lease retains only the current review for at most 180 seconds and removes it when switching or ending. A crash may leave that generation's temporary file; recovery never uses it as the current frame.

Acquisition rearms five seconds after completion, without overlapping jobs. Frames remain briefly in memory and are reduced to a maximum dimension of 960 pixels. Enabling companionship does not enable cameras, microphones or system audio. Window or title changes invalidate earlier replies and cancel only the activity's previous speech scope. Capture interruption pauses the activity after 20 seconds and resumes when foreground capture returns. Explicit pauses, hiding, muting and ended sessions do not resume this way.

The bound local DSH owner is discovered automatically. If offline, its Home's existing `start-dsh.ps1` entry starts it; the current launch log supplies its endpoint and local login. Recovery verifies the original session ID and workspace, without port scanning, replacement sessions or overriding an explicit disconnect. Failures back off for 60–120 seconds and never replay an uncertain delivery. The pet menu displays recognition or recovery status. Automatic launch requires an existing supported local DSH launcher; other Agents retain their own delivery contract.

Foreground players, video page titles and matching foreground video playback metadata classify the scene before the Agent replies. Playback metadata is read-only; background music is not foreground video evidence. Rules live in `packages/rabi-companion/scene-rules.json`; unmatched scenes retain Agent visual classification. Every review returns classification, including empty text when remaining quiet. An uncertain reply preserves existing window evidence. Automatic classifications may return within 180 seconds; scene comments expire after 30 seconds and are then discarded without speech.

Packs can map `watch` and `play` to looping actions through `companionStates`. Watching retains the sofa pose and playing retains the gaming chair pose while comments use the bubble. Ordinary random actions, sleep and wandering pause during companionship. Scene changes switch poses; pausing or ending leaves the scene pose, and ending restores ordinary idle behavior. Packs without the mapping retain their existing presentation.

While companionship is enabled, the pet remains visible over fullscreen applications and pauses random wandering. Ending restores its settings. Existing click-through settings are preserved; use the tray to disable click-through before right-clicking. Exactly one enabled local Agent Route is required for menu admission; the management page can explicitly use a selected Route. Manager retains the desktop enable intent in a machine-local recovery checkpoint. After Manager or pet restart, the original Route is revalidated and a fresh activity starts, without reusing frames, replies or speech. Explicit pause, hide, mute or stop clears recovery intent. The optional browser local-video player does not resume automatically.

When browser tabs change, Manager invalidates the previous review and updates the scene in the same request that accepts the fresh frame. Cancelling old speech does not delay capture delivery. Expired frames are reacquired rather than replayed. Failed watch/play animation loads retain the desired scene and retry with a 1.5–30 second backoff. Ending companionship, hiding or closing the pet stops retries.

## All-day recording

If all-day recording is already enabled for the persona, ending companionship saves an activity summary and timeline entry without duplicating raw companion frames. Capture sources and recording settings are preserved. Otherwise the menu activity remains ephemeral. Turning recording off before ending also suppresses summary persistence. The persona's **Shared activities** page can explicitly opt into saving progress and discussion.

The optional local-video player accepts WebVTT subtitles and synchronizes current position and active subtitle cues. Future subtitle content is not sent to the Agent. The manual speech button records at most 30 seconds through the existing ASR service, then submits the transcript as user speech. It does not listen continuously or transcribe media audio.

## Validation and limitations

Automated checks cover bounded delivery, reply expiration, window-switch invalidation, settings restoration, menu admission, summary persistence and scoped speech cancellation. Actual games, player compatibility, exclusive fullscreen/protected capture, Agent timing and audible output require separate on-device acceptance. Black or unreadable frames must be reported honestly. Visual inference does not precisely determine dialogue start/end times.

## API

Discover `managerBaseUrl` from the current Host `status --json`, then verify generation and instance against `/meta`. Endpoints retain Manager authentication. Authenticated remote Agents and local clients share the public contract; explicit user disable settings remain effective.

- `GET /api/roles/{roleId}/companion`: presets and current session.
- `POST .../start`: `requestId`, optional `gatewayId`, `presetId`, `title`, `autoReview`, `voice`, optional `saveSummary`, `observationOwner`.
- `POST .../command`: `sessionId`, `revision`, `action` (pause/resume/seek/interrupt/stop); seek also requires `positionSeconds`.
- `POST .../observation`: session/revision plus ordered, timestamped JPEG `observation`.
- `POST .../review`: session/revision and optional user `text`.
- `GET .../frame?reviewId=...`: frozen review frame, unavailable after expiry.
- `POST .../reply`: `sessionId`, `revision`, `reviewId`, `text`, optional `state` and `activityKind` (play/watch/other/uncertain). Empty text means silence.
- `GET .../last`: latest opted-in summary; never starts or resumes a session.

The companion module does not automatically create memories or plans. Reduced frames and text delivered to the Agent may still be retained by the existing Route as attachments, chat history or caches under its existing retention policy; disabling activity summaries does not delete Agent history. Summaries use atomic writes and stable activity IDs. Manager owns live session state. Agents must return fenced replies; an expired 409 ends silently without task announcements or external messages.

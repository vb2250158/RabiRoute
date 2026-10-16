[English](companion-mode_en.md) | [简体中文](companion-mode.md)

# Desktop-pet companion mode

Companion comments use the [shared desktop pet bubble and speech presentation](desktop-pet-bubbles_en.md). Text follows playback and fades after its display lease. Ordinary persona speech shares the same customizable bubble, without collapse or replay buttons.

Status: experimental. Enable **Companion mode** from the Windows pet's context menu, then choose Adaptive, Watch together, Play together, Work mode or Quiet company under **Companion style**. Options come from Manager's preset catalog. Switching retains the session, Route and discussion while invalidating earlier frame replies and speech.

The pet observes the foreground window and sends its current frame, title and process name to this persona's enabled local Agent Route. Adaptive mode classifies playing, watching, working, other or uncertain activities. Explicit watch, play and work modes retain the chosen activity kind. It stays quiet during focused work or uncertain observations, discusses only visible story content without looking up future plot, and observes games without controlling them. Classification can be returned without speech. Reduced frames are delivered as actual image attachments. The local attachment lease retains only the current review for at most 180 seconds and removes it when switching or ending. A crash may leave that generation's temporary file; recovery never uses it as the current frame.

Work mode delivers the current frame to the Agent every 60 seconds. Automatic reviews only update classification, without displaying or speaking comments; explicit questions can receive replies. Quiet company reviews only when the user speaks. Capture still rearms every five seconds; preset timing controls delivery to the Agent.

Acquisition rearms five seconds after completion, without overlapping jobs. Frames remain briefly in memory and are reduced to a maximum dimension of 960 pixels. Enabling companionship does not enable cameras, microphones or system audio. Window or title changes invalidate earlier replies and cancel only the activity's previous speech scope. Capture interruption pauses the activity after 20 seconds and resumes when foreground capture returns. Explicit pauses, hiding, muting and ended sessions do not resume this way.

The bound local DSH owner is discovered automatically. If offline, its Home's existing `start-dsh.ps1` entry starts it; the current launch log supplies its endpoint and local login. Recovery verifies the original session ID and workspace, without port scanning, replacement sessions or overriding an explicit disconnect. Failures back off for 60–120 seconds and never replay an uncertain delivery. The pet menu displays recognition or recovery status. Automatic launch requires an existing supported local DSH launcher; other Agents retain their own delivery contract.

Foreground players, video page titles and matching foreground video playback metadata classify the scene before the Agent replies. Playback metadata is read-only; background music is not foreground video evidence. Rules live in `packages/rabi-companion/scene-rules.json`; unmatched scenes retain Agent visual classification. Every review returns classification, including empty text when remaining quiet. An uncertain reply preserves existing window evidence. Automatic classifications may return within 180 seconds; scene comments expire after 30 seconds and are then discarded without speech.

Packs can map `watch`, `play` and `work` to looping actions through `companionStates`. Watching retains the sofa pose and playing retains the gaming chair pose. Work uses its mapped pose, falling back to a looping thinking action or idle when unavailable. Comments use the bubble. Ordinary random actions, sleep and wandering pause during companionship. Scene changes switch poses; pausing or ending leaves the scene pose, and ending restores ordinary idle behavior.

## Mode animation sets

Use `modeAnimationSets` when each mode needs its own idle and gestures. The current preset ID takes precedence over activity kind. Adaptive classification can therefore select the `work` set as well.

```json
"modeAnimationSets": {
  "work": {
    "idleState": "work-idle",
    "randomIntervalSeconds": {"min": 45, "max": 120},
    "randomStates": ["work-type", "work-read", "work-stretch"],
    "clickStates": ["work-nod"]
  }
}
```

The set's idle must loop. Random and click actions play once and declare `next` as that set's idle. Clicks prefer the set's click pool; random gestures run only when playback is available. Speech retains the current pose within the set, and dragging or travel restores the current mode after ending. Switching drops old gestures. Companionship pauses sleep, and ending restores ordinary idle, sleep and wandering settings.

Older `companionStates` mappings retain their single looping pose without copying the ordinary random pool. New packs use `modeAnimationSets`, with the old mapping used only when no set matches. In the new pack, declare the set and remove its same-name legacy mapping. Import a new immutable ID and retain the accepted old pack; do not overwrite it.

While companionship is enabled, the pet remains visible over fullscreen applications and pauses random wandering. Ending restores its settings. Existing click-through settings are preserved; use the tray to disable click-through before right-clicking. Exactly one enabled local Agent Route is required for menu admission; the management page can explicitly use a selected Route. Manager retains the desktop enable intent in a machine-local recovery checkpoint. After Manager or pet restart, the original Route is revalidated and a fresh activity starts, without reusing frames, replies or speech. Explicit pause, hide, mute or stop clears recovery intent. The optional browser local-video player does not resume automatically.

When browser tabs change, Manager invalidates the previous review and updates the scene in the same request that accepts the fresh frame. Cancelling old speech does not delay capture delivery. Expired frames are reacquired rather than replayed. Failed watch/play animation loads retain the desired scene and retry with a 1.5–30 second backoff. Ending companionship, hiding or closing the pet stops retries.

## All-day recording

If all-day recording is already enabled for the persona, starting, user discussion, Agent replies and mode/pause changes checkpoint progress; ending saves a summary and timeline entry. Raw frames, window titles and subtitles are not saved. Capture sources and recording settings are preserved. Otherwise the menu activity remains ephemeral. Turning recording off stops subsequent checkpoints and summaries but does not delete existing records. The persona's **Shared activities** page can explicitly opt into saving progress and discussion.

The optional local-video player accepts WebVTT subtitles and synchronizes current position and active subtitle cues. Future subtitle content is not sent to the Agent. The manual speech button records at most 30 seconds through the existing ASR service, then submits the transcript as user speech. It does not listen continuously or transcribe media audio.

## Validation and limitations

Automated checks cover bounded delivery, reply expiration, window-switch invalidation, settings restoration, menu admission, summary persistence and scoped speech cancellation. Actual games, player compatibility, exclusive fullscreen/protected capture, Agent timing and audible output require separate on-device acceptance. Black or unreadable frames must be reported honestly. Visual inference does not precisely determine dialogue start/end times.

## Persona companionship configuration

Each discussion reloads `persona.md` (or the Route's configured persona file), `prompts/companionship.md`, optional `growth.md` and `skills/companionship-response.md` from the current persona directory. A missing response Skill does not prevent loading an existing companionship prompt. Missing, empty or invalid required persona/prompt files fail delivery instead of using generic comfort text. Global mode presets govern observation timing, behavior and replies, not persona voice.

Use the persona's `personaConfig.json` to select its own prompt and additional mode templates. Without configuration, the existing `prompts/companionship.md` is loaded without migration:

```json
{
  "companion": {
    "promptFile": "prompts/companionship.md",
    "templates": { "watch": "prompts/companionship-watch.md" }
  }
}
```

Paths must stay inside the persona directory, including junction targets. Templates support `{roleId}`, `{presetId}` and `{activityKind}`. Mode templates follow the base prompt and cannot override mode/reply constraints. See `examples/data/roles/Rabi/`.

Manager sends role-panel and plan-feedback message text through child stdin (up to 256 KiB UTF-8), avoiding Windows command-line limits after URL-encoding Chinese context. CLI `--role-panel-text=` / `--plan-feedback-text=` remain for existing external callers, but Manager no longer uses them. Messages still follow the same Route and bound Agent, without a fallback execution owner.

Persona context is limited to 28,000 characters: at most 6,000 each for persona/base prompt, 3,000 each for mode/growth, and 1,500 for the response Skill. Recent memory includes only the three newest unarchived summaries and detail endpoints from Manager's published catalog, without bodies or directory scans. An unavailable catalog fails delivery until a subsequent normal attempt. Historical summaries include at most four discussion notes; historical window hints are limited to 1,500 characters. Longer sources are read only when relevant. History is explicitly background, never live evidence or operational instructions.

With saving enabled, `companion/sessions/<activityId>.json` updates a stable activity file. `companion/state.json` records the latest activity and `lastInteractionAt`: the start or most recent user discussion/accepted text response, not automatic captures or silent classification. `companion/last.json` points only to the latest ended, saved summary, so starting a new activity preserves access to the previous summary. Serialized writes prevent older asynchronous checkpoints from overwriting the ended summary. Reading history never restores an activity; recovery still revalidates the original Route.

## API

Discover `managerBaseUrl` from the current Host `status --json`, then verify generation and instance against `/meta`. Endpoints retain Manager authentication. Authenticated remote Agents and local clients share the public contract; explicit user disable settings remain effective.

- `GET /api/roles/{roleId}/companion`: presets and current session.
- `POST .../start`: `requestId`, optional `gatewayId`, `presetId`, `title`, `autoReview`, `voice`, optional `saveSummary`, `observationOwner`.
- `POST .../command`: `sessionId`, `revision`, `action` (pause/resume/seek/interrupt/stop/set-mode); seek requires `positionSeconds`, and set-mode requires a catalog `presetId` and returns the updated session revision.
- `POST .../observation`: session/revision plus ordered, timestamped JPEG `observation`.
- `POST .../review`: session/revision and optional user `text`.
- `GET .../frame?reviewId=...`: frozen review frame, unavailable after expiry.
- `POST .../reply`: `sessionId`, `revision`, `reviewId`, `text`, optional `state` and `activityKind` (play/watch/work/other/uncertain). Empty text means silence.
- `GET .../last`: latest ended, opted-in summary; never starts or resumes a session.

The companion module does not automatically create memories or plans. Reduced frames and text delivered to the Agent may still be retained by the existing Route as attachments, chat history or caches under its existing retention policy; disabling activity summaries does not delete Agent history. Summaries use atomic writes and stable activity IDs. Manager owns live session state. Agents must return fenced replies; an expired 409 ends silently without task announcements or external messages.

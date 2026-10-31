English | [简体中文](desktop-pet-bubbles.md)

# Desktop pet bubbles and speech

With Show bubbles enabled, newly saved Agent replies delivered to that persona panel appear verbatim on its pet. Only live notifications are shown; history is not replayed. User input, drafts, failed deliveries and other personas are excluded. Message IDs are deduplicated, and consecutive messages display in order with at most the latest 32 waiting messages retained. Display waits for active speech and is skipped while bubbles are disabled or the pet is hidden or muted. This displays text only and does not synthesize speech.

A click starts the response animation immediately on release; another click restarts it. Double-clicking still opens the persona panel, with no additional response on the second release. Dragging starts only after the pointer crosses the system drag threshold. Minor jitter remains a click, and only an actual drag saves the position. When a response finishes, ongoing speech or companion animation resumes. Random idle actions and sleep continue scheduling after a menu, held pointer, or interaction temporarily blocks them.

The context menu's size entry shows the current percentage. Open it to drag a slider from 10% to 200% in 1% increments. Dragging scales the already loaded frames for an immediate preview while animation continues. Releasing the slider or leaving the size submenu does not rebuild animation. Closing the entire context menu applies the final size once and saves it automatically; returning to the original size requires no rebuild or save. Reopening the menu or restarting restores the saved size.

Enable “显示气泡” (Show bubbles) in the pet's context menu. Companion comments, task results and local persona speech share an ordinary dialogue bubble. When a RabiSpeech host FIFO job starts and its `voice` matches the pet's persona ID, the bubble shows its text and the pet uses the talking action. After playback, it stays for eight seconds by default. Ordinary notices do not replace active speech text.

The bubble shows text only. Long text scrolls, capped at 4,000 characters. It does not take focus. Click-through also applies to the bubble. Hiding the pet or disabling bubbles affects display; audio remains under the speech queue's controls.

Choose “气泡样式…” (Bubble style) from the context menu to preview and save the cat-paw or plain skin, system font, size (12–24 px), text color, width (220–480 px), opacity (50–100%) and lifetime (2–30 seconds). The plain skin also supports background and outline colors. The persona's pet panel exposes the same settings. Each persona saves its own style, restored after restart. Nine-slice rendering keeps the bottom-right paw fixed in size. An independent pointer tracks the visible pet artwork’s horizontal center while the frame clamps to screen edges. If there is insufficient room above, the bubble moves below the pet with an upward pointer. Text remains clear of the decoration.

Desktop subscribes to Manager `/api/speech/events` and reads `/api/speech/playback/status` to restore currently playing speech. Reconnection neither displays completed history nor replays audio. Qt renders only; RabiSpeech owns synthesis, playback, cache and queue state.

## Persona dialogue

Companion openers and local notices only read `desktop-pet/dialogue.json` in the current persona directory. They never borrow dialogue from animation packs, another persona or shared caches. Missing, malformed or unavailable configuration uses neutral notices. Example:

```json
{
  "schemaVersion": 1,
  "personaId": "sample-persona",
  "openers": { "watch": "Let's watch together.", "play": "I'll keep you company.", "work": "Let's get started." },
  "fallbacks": { "companionInterrupted": "Reconnecting.", "managerInterrupted": "The service is temporarily unavailable." }
}
```

`personaId` must match the directory's persona ID, `schemaVersion` must be `1`, and the file limit is 64 KiB. Each nonempty string is limited to 1,000 characters. Additional fallback keys are `companionFailed`, `actionUnavailable`, `bubbleStyleSaved` and `bubbleStyleFailed`, for companion failures, unavailable actions and style save results. Only missing entries use neutral defaults. Desktop rereads on creation, Manager reconnection or matching pet settings changes. After editing the file directly, save that persona's pet settings to refresh it.

## Text records (maintainers)

Manager writes individual records to the persona directory's `desktop-pet/transcripts/<tts|asr>/<first-two-hash-characters>/<hash>.json`. TTS comes from playing host jobs observed by that pet with an exact persona `voice` match. Reconnection can capture the current job but does not backfill completed history. Hiding bubbles does not disable recording. ASR follows Routes selecting that local persona and retains normalized speaker text; unassigned speech and remote personas do not write into local pet directories. Full ASR evidence remains in `voice-transcripts.jsonl` and the existing conversation history; RabiSpeech retains synthesis and playback evidence.

These files are persona-scoped text projections, not another delivery queue. Schema version `1` contains `personaId`, `kind`, original `id`, `source`, `text` and Unix-seconds `time`; order by `time`, then `id`. SHA-256 of `kind + source + id` gives a directly addressable file key. Existing file locks and atomic writes protect persistence; identical retries return already saved, while conflicting content is rejected. No full-scan index is needed. Original records remain intact. There is no automatic archival, consolidation or deletion; per-record storage does not apply the 24/72-hour archive windows. Qt uses a five-second write timeout and at most three attempts three seconds apart, logging final failures. Power loss, closing Desktop or exhausted retries do not provide cross-restart backfill for unconfirmed text.

### Manager API

Use existing Manager connection authentication without additional per-interface permission. Host/READY publishes the current address. `{baseUrl}` is the full URL verified against `/meta`; URL-encode `{personaId}`.

- `GET {baseUrl}/api/desktop-pet/roles/{personaId}/dialogue` returns `{ "code": 0, "data": { "personaId": "sample-persona", "dialogue": { "openers": {}, "fallbacks": {} } } }`, containing only valid strings from that persona. Clients apply neutral defaults per missing entry.
- `POST {baseUrl}/api/desktop-pet/roles/{personaId}/transcripts`, with `Content-Type: application/json`, accepts `{ "personaId": "sample-persona", "voice": "sample-persona", "kind": "tts", "id": "playback-job-id", "text": "Hello.", "time": 1710000000 }`. It returns `{ "code": 0, "data": { "personaId": "sample-persona", "appended": true } }`. Repeated content returns `appended=false` as an already-saved receipt. Internal routing owns ASR recording; clients cannot report ASR through this endpoint. The payload limit is 64 KiB. Audio and extra fields are not stored.
- Invalid IDs, persona mismatches, invalid text/timestamps, conflicting content and read/write failures return `400`, `code=-1` and `message`, without acknowledging persistence. Unsupported methods return `405`. After timeout, retry the same ID and payload, never a new ID. The saved file is durable readback evidence; no separate receipt-query API is provided.

Manager owns the persona binding's `bubbleStyle`, updated through the existing `/api/desktop-pet/roles/{personaId}` endpoint. Desktop does not write settings files. The desktop runtime includes `rabiroute_tray/assets/bubble-cat-paw-body-v2.png`; the asset notes describe slice ratios and fixed destination sizes. Browser-local audio, remote playback and voices without a matching persona ID do not attach to the local pet.

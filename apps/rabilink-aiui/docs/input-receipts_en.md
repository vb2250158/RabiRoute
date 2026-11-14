English | [简体中文](input-receipts.md)

# Speech input while tools are waiting

Rabi uses shared assistant SDK 0.7.2's per-input `interject` API. Complete speech arriving during a tool wait is persisted and read back before submission to the same Rokid host model. Model requests remain serial. Interjection formats are supplied only with independent requests, not persistent instructions shared by every turn. Speech corrections before tool dispatch still use existing steering; they are not presented as independent task receipts.

Independent input keeps its original text, stable ID, history ticket and task scope. Explicit answers are saved to their own record before requesting subtitles/TTS, never appended to original task text/history. Inputs needing tools retain only original text and await a fresh decision under their original ID after the current turn. Cached proposed actions are never executed.

Defer may carry an optional nonempty explanation of at most 16000 characters. Parsing discards it: it is never spoken, saved as an answer or treated as completion/execution evidence. Protocol, request/input IDs and allowed fields remain strictly validated.

Each input captures its profile, connection scope, device owner, API runtime and model generation. Checks precede a subsequent turn and every model/tool boundary; changed connections, hidden or destroyed views cannot transfer inputs to a replacement task. A newer utterance prevents an older independent answer from taking over subtitles or starting speech, while preserving its record. Stopping speech never cancels dispatched backend work.

## Local records and recovery

`aiui-input-ledger.js` owns pending independent input using documented wx synchronous storage. Conversation history and PC tool receipts retain separate owners. Records contain no credentials. Storage failure, readback mismatch or corrupt data prevents submission.

- `submitted` reserves an attempted model submission; `running` reserves a subsequent normal turn. After process interruption, both become unconfirmed without replay.
- Deferred/retained inputs may queue only within their original active page and valid binding. Recreating a page never executes them under a new connection.
- Answered proves generated text was saved locally; completed proves an assistant turn ended. Neither certifies glasses presentation, audible speech or backend task completion.
- At most 64 records are kept. New input may evict only the oldest answered/completed cache. Unfinished records are retained; capacity exhaustion rejects input and displays its text.

Restart shows the pending count and last original text. Tap the footer record entry or press Up in conversation mode to inspect original text, saved answers and processing status. Left/right selects records; up/down pages through two short lines; confirm/back closes the view. Original long text is not truncated. Read failures show an error while retaining access to the viewer.

The viewer reads ledger snapshots only: it never performs recovery transitions, submits model input, or stops capture/inference. New records preserve the current selection; saved results refresh the selected record. Hiding closes the viewer, and persistent records remain readable after reopening. There is no retry or mark-complete action. Manually repeating input is not a safe original-task retry; reconcile dispatched operations against their original backend receipts.

## Validation scope

17 page-guidance/ledger tests cover independent history, fresh deferred decisions, stable IDs, storage failure, stale-answer suppression, binding changes, rereading, unknown-outcome retention, capacity, read-only browsing, complete Unicode/multiline pagination, live settlement and error clearing. The 38 compiled-page contracts include speech generation during tool waits, original-ID deferred execution, cleanup fencing, recovery of original text and record navigation preserving live tasks/capture. Model, input, storage and voice resources are fixtures.

The real Ink record-view check uses isolated in-memory records on 480×352 and 448×150 surfaces to exercise opening, pagination, record selection and return. It does not validate device storage. An [official real-model probe](tool-wait-probe_en.md) passed answering during a tool wait, deferring another tool request and executing it after the original turn; tools, transcripts and storage are fixtures. Device storage, human ASR/TTS and acoustic duplex remain unverified.

<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-aiui-native-parity.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# AIUI to Phone / Native-Glasses Parity Checklist

> The goal is not to retain the AIUI runtime. It is to retain and improve every user-visible capability. The phone is the complete client and reliable backend; glasses are an optional audio, HUD, camera, and touchpad peripheral.

`Complete` requires code plus automated/build evidence. `Partial` has a main path but lacks recovery or physical-device evidence. `Missing` cannot be claimed as parity.

| AIUI capability | Phone alone | With glasses | Status | Equivalent implementation |
| --- | --- | --- | --- | --- |
| Continuous listening after setup | Foreground phone microphone | Glasses automatically stream PCM | Partial | Android streams ordered PCM while the Rabi PC owns VAD, segmentation, ASR, and voiceprint processing; long-running physical acceptance remains |
| One-tap immediate Agent review | Phone review action | Default glasses action | Complete | Durable control queue -> `rabilink.review_request` -> idle start / active-turn steer |
| Store one host raw record, then apply Route policy | Same | Same | Complete | PC ASR writes one host-wide speech record; enabled `rabilink` Routes then apply `hot/keyword` per persona, while no subscription remains record-only. Ordinary observations can still use independent review. |
| Reflection and proactive messages | Same | Same | Complete | PC reviewer, RabiActive, and Outbox are client-independent |
| ASR recovery and utterance segmentation | PC RabiSpeech | PC RabiSpeech | Partial | Strict chunk sequences, Android stream recreation, and a chunk-rearmed one-shot 15-second PC expiry exist; public-network and device recovery still need acceptance |
| 48-hour / 2000-segment offline uplink | Not applicable to live audio | Not applicable to live audio | Missing | Text/control/media remain durable; live PCM during a network outage is not promised to be cached or replayed |
| Duplicate and TTS-echo suppression | Same | Same | Complete | 2.5-second duplicate and 12-second reply-echo filters; capture yields during playback |
| Cursor downlink and offline backlog | Phone service | Phone backend | Partial | Cursor, cached PCM, and delivered memory exist; physical glasses playback ACK remains |
| Failed TTS yields queue head | Phone speaker | Glasses speaker | Complete | Message/PCM persistence; yield after three failures with backoff or explicit retry |
| Latest transcript/reply/status | Phone conversation card | Glasses HUD | Complete | Shared backend events update both surfaces |
| Clock/battery/charging/version | Phone OS | Glasses HUD | Partial | Clock/version and real CXR battery protocol are wired; physical refresh acceptance remains |
| Pause/continue/retry | Phone controls | One-row glasses controls | Complete | Listening pause/continue and explicit ASR/TTS failed-item retry |
| Custom ASR/TTS/language/voice | PC-owned ASR; phone-selected downlink TTS | Reuses the same settings | Complete | ASR/VAD/language belong to target-PC RabiSpeech; the phone retains only downlink TTS model and persona-voice selection |
| Full PC configuration | Remote WebGUI on phone | Not duplicated on glasses | Complete | PC remains configuration truth through `/manage` |
| Natural-language configuration assistant | Separate Settings entry | Optional glasses voice entry | Complete | Configuration no longer shares the chat composer; marked requests retain the allowlist, action gate, and success/read-back requirement |
| Enrollment and multi-PC selection | App token and PC picker | Inherits phone binding | Partial | SN token claim is replaced; QR/short-code enrollment and rotation remain |
| Safe cloud diagnostics with offline replay | Phone backend | Glasses errors forwarded by phone | Complete | 500-entry/7-day private queue with no chat text, transcripts, tokens, or request bodies |
| Text/image/video/audio/arbitrary files | Full bidirectional chat | Glasses photo/audio input | Complete | Arbitrary phone picker, `allowedFileRoots` PC downlink, 64 MiB app-isolated attachments, including attachment-only delivery |
| Two ongoing and normal Agent notifications | Open app / one-tap prompt | Shared phone notifications | Complete | Foreground status and prompt shortcut remain; normal messages aggregate per conversation, deep-link to detail, and clear when read |
| Automatic or manual Agent TTS | Setting | Shared setting | Complete | Disabled autoplay preserves a tappable WAV in chat |
| Multiple PCs and route personas | Conversation list, details, and unread state | Uses current persona | Complete | Only RabiLink Routes become contacts; drafts/read state are scoped per conversation, uplink/downlink freeze `routeProfileId`, and notifications deep-link correctly |
| Message recovery after reboot | Restores cursor, queues, and notifications | Capture resumes after opening the app | Complete | Boot uses a `dataSync` FGS and avoids Android's ban on launching a microphone FGS directly from a boot broadcast |
| Phone works without glasses | Complete microphone/speaker/UI | Toggle adds glasses I/O | Complete | Conversation list/detail, service, attachments, notifications, and the separate configuration assistant do not depend on glasses |

## Completion rule

Code parity is not a substitute for device acceptance. Every remaining Partial row must pass separately on a phone and real glasses before the release can claim full AIUI parity.

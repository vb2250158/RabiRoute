English | [简体中文](persona-companion-api-contracts.md)

# Role companion API contracts

Status: eight public routes use executable operation registration. Native-owner and isolated HTTP regressions do not establish acceptance of desktop capture, real Agent delivery or speech playback.

`createPersonaCompanionOperations` registers `GET /api/roles/:roleId/companion`, `GET .../last`, `GET .../frame`, and `POST .../start`, `.../command`, `.../observation`, `.../review`, `.../reply`. There was no `/roles` alias and none is added. JPEG reads retain the current review’s expiry and session-revision checks.

`CompanionActivity` remains the sole owner of the activity, frame buffer, observation sequence, reviews, original Agent/TTS callbacks and summaries. Start retains requestId and the complete input fingerprint; commands retain full sessionId and revision, and replies retain reviewId and deduplication. Mode changes, pause, stop and the 20-second producer lease keep their native behavior. The original `CompanionContinuationStore` owns desktop resume intent: pause and stop clear it; resume and mode changes update it. Failed progress or summary writes require reading the original session rather than resending a real delivery automatically.

Preparation captures the original connection, role directory, Manager identity and service. Controls still require a JSON object, `application/json`, and at most 3 MiB. Native command and persistence queues recheck the owner when entered; asynchronous role-context completion, delivery and speech also retain owner checks. Accepted native work is joined until its actual terminal state; caller cancellation does not prove that work was cancelled. Persisted summaries and attempted deliveries are not rolled back, and failures may be marked `uncertain`. Window-classification caches distinguish the current directory; queued writes retain the original path instead of following a configuration change into another role directory.

Host callbacks must accept the optional `assertCurrent` and carry it through their own asynchronous steps. Context, ASR, transcript reads, delivery, speech and summary callbacks recheck after waits and before the next real action. Native summaries, window classifications and continuation intent use the same atomic-write helper, checking again before writes and replacements. Playback transcript persistence combines the caller assertion with the original capture-session fence.

Authenticated enabled remote connections can use all these public APIs by default. Routes and role configuration choose the correct execution target without granting additional features. Local entry points retain their existing origin and read-only checks. Actual answers, capture, playback and persistence remain with their original owners. See [companion mode](companion-mode_en.md) for usage and field-acceptance limits.

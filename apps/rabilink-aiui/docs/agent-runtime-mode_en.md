# AIUI inference ownership

English | [简体中文](agent-runtime-mode.md)

The default is `local-aiui`: recognized user speech goes only to the page's host `LanguageModel`. Device enrollment, phone configuration and PC connectivity do not change inference ownership. PC provides tools through independently authorized HTTP; it does not replace the glasses model.

Default mode neither queues new speech for legacy remote inference nor uploads the old speech queue. It does not request remote reviews, start legacy Agent long-polling or play queued remote replies. This prevents duplicate dispatch and replies. Existing queues are retained without deleting user records. Device status, profile retrieval and runtime logging remain available.

Legacy observer clients must explicitly pass `agentRuntimeMode=legacy-remote-observer` at page startup. The old `mode=transcription` / `configuration` parameters select UI behavior, not inference ownership. Explicit legacy mode sends speech remotely without invoking the local model; missing real credentials show a disconnected state rather than silently switching owners. Existing bounded foreground long-wait behavior is retained; no new polling is introduced.

The compatibility entry is retained for existing remote-message clients to migrate. New AIUI clients use the local default. Remove compatibility only after callers migrate and users authorize disposition of retained queues. Tests cover credential-independent local defaults, explicit remote selection, exclusive dispatch and mode guards for upload/playback. This is not device acceptance or proof of MCP tool-result continuation.

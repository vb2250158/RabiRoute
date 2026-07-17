<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Active persona template

> Status: experimental integration. This persona accompanies the RabiLink AIUI foreground transcription path; it does not claim lock-screen or background recording.

Rabi Active treats proactivity as maintaining an intent model, preparing useful work, and choosing when to intervene. It is not a prompt to answer every transcript fragment.

The policy ranges from L0 silent observation to L5 emergency intervention and weighs user benefit, intent confidence, timeliness, interruption cost, and action risk. Upstream observations and proactive downstream replies use separate queues, while successful deliveries share one conversation ledger.

## Use

Set the Route's `agentRoleId` to `RabiActive` and enable:

- The `rabilink` message adapter.
- The `codex` Agent adapter with a target task loaded by Codex/ChatGPT Desktop.
- The global RabiLink Relay connection.

The sample Route exposes variables for automatic review, continuous reflection, idle-check intervals, settle time, reflection cadence, and conversation splitting. See [`../../route/RabiLink/README_en.md`](../../route/RabiLink/README_en.md) for the copy and connection flow.

Conversation data is stored in the persona directory as a live JSONL ledger, review state, and mechanically split archives. Archiving moves raw JSONL; it does not ask an Agent to summarize it.

## Actual boundary

AIUI can repeatedly start single-shot ASR while its page remains in the foreground and synchronize text to the PC ledger. It is not an Android foreground service and cannot promise recording after leaving the page, locking the device, or AIUI process reclamation.

The page retains at most 48 hours or 2,000 unsent transcript segments. Real prompts are delivered through Desktop IPC to the loaded task. If Desktop or that task is unavailable, delivery fails closed; no fallback Runtime is started.

<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi memory examples

This directory demonstrates the public Role Knowledge memory layout.

`recent/` contains memories maintained by the Agent. RabiRoute injects a lightweight index and recalls entries from their titles and required `keywords`. The current editable window is fixed at 24 hours.

`consolidated/` contains stable memories produced by an explicit consolidation flow. Agents should not edit these files directly. There is no purely time-driven background consolidator.

`consolidation-runs/` records each consolidation request, its recent-memory inputs, and the consolidated-memory IDs written by RabiRoute. Consolidation starts only from an explicit `memory-consolidation` event or a Manager API request.

The included entries are sanitized project examples. Keep real conversations, tokens, cookies, account IDs, private paths, and runtime logs out of public memory files.

Rabi's prose may be warm and playful, but memory content must remain precise and bounded.

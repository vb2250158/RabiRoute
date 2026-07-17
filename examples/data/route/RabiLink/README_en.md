<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink proactive-intelligence Route template

> Status: experimental integration. The template and local code paths exist, but a real Relay, AIUI device, and loaded Desktop task are still required for environment acceptance.

This Route pairs with `examples/data/roles/RabiActive`. It demonstrates a record-first glasses observation ledger, idle or periodic Codex review, touchpad-triggered review, and proactive downstream delivery.

Copy both directories into runtime data:

```text
examples/data/route/RabiLink   -> data/route/RabiLink
examples/data/roles/RabiActive -> data/roles/RabiActive
```

The template is disabled by default. Configure the Relay URL, application token, PC identity, and connection switch in RibiWebGUI's global Rabi instance settings. Then verify the Route port and enable `RabiLink`. Relay credentials never belong in this template or the repository.

AIUI observations are written to `RabiActive/rabilink-conversation.jsonl` before review; they are not forwarded to Codex one line at a time. Review waits for the bound Desktop task to become idle or is steered by a touchpad click.

Proactive Codex replies use `/api/agent/replies` with `targetType=rabilink` and `proactive=true`. Upstream observations and downstream replies have separate queues. Desktop IPC is the sole owner of real prompt delivery, and an unloaded target task fails closed.

FenneNote can be added as an explicit record-first source with its own unoccupied port, input-only policy, and `routeVariables.rabilinkRecordFirstSources=fennenote`. The sample leaves this empty because PC and glasses microphones are different consent surfaces.

Port `8794` is only an example. Check conflicts in WebGUI before enabling the Route.

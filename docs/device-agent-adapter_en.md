<!-- docs-language-switch -->
<div align="center">English | <a href="./device-agent-adapter.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Device Agent (experimental)

`deviceAgent` binds a message route to an actual device Agent. Route settings read `/api/device-agents` and save its stable `agentId` together with the owning PC's `RabiGuid` (`binding.instanceId`). That identity is separate from the LAN Registry's local instance ID. Refreshing an unavailable or unbound device catalog displays a configuration prompt.

The device owns model turns, speech and tool execution. The PC stores deliveries, wake requests and device receipts. Rokid AIUI uses the model, ASR and TTS configured by Rokid. A queued delivery or a phone submitting a wake command does not establish owner acceptance; delivery must wait for the actual device owner's receipt. Keep the original `deliveryId` when the result is unknown and read its receipt before attempting another delivery.

Declared capabilities are ordinary message route delivery and AgentThreads listing, reading and delivery for registered device sessions. Independent message-processing sessions, plan assistants, memory consolidation, lifecycle hooks and generic receipt recovery are undeclared. Settings select devices from their catalog; they offer neither an unbound local device entry nor changes to the host model or fabricated session IDs.

Maturity remains `experimental`. Source tests cover registration, restricted capabilities, saved bindings, factory dispatch and the device owner protocol. Physical wake, actual responses, continued delivery to the same session and concurrent ASR/TTS still require device acceptance testing. Source tests do not establish deployment or physical acceptance.

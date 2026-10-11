<!-- docs-language-switch -->
<div align="center">
English | <a href="./aiui-agent-acceptance.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# AIUI Agent Integration and Acceptance

This implementation is experimental. Automated source tests and physical-device acceptance are recorded separately. Server deployment, installed versions, platform uploads and end-to-end glasses verification depend on the acceptance records for the target environment.

AIUI uses the Rokid-configured model, ASR and TTS. A persona binding supplies its instructions, Skills, history and default PC; callers can explicitly select another PC. Persona, workspace and Route bindings do not restrict authenticated API access. Devices without a persona and enabled remote Agents can call all Manager business APIs.

## Current contract

| Requirement | Owner | Acceptance |
| --- | --- | --- |
| Persona, Skills, default PC and history | Persona PC; device keeps the binding reference; Rokid owns the model | Source and isolated tests; phone save through the next glasses turn remains unverified |
| Current and future Manager APIs | Generic HTTP contract and target PC; Relay has no business API whitelist | Generic and unknown-API tests; installed server and PC integration pending |
| Cross-PC capabilities | Target identity, application connection and shared transport | LAN/P2P/Relay and independent-Manager bidirectional message and formal-reply HTTP tests; actual glasses and cross-network dual-PC paths pending |
| Automatic Route delivery | `deviceAgent` adapter, PC mailbox and glasses model owner | Original IDs, epochs, owner claims and rejection tests; real wake/claim/response pending |
| Wake request | Phone claims a nonce and triggers the configured Rokid custom instruction | A normal app's simulated two-finger broadcast was rejected on-device; the referenced chapter documents reception, and sending remains unverified |
| Voice output/input | The same glasses Agent speaks each sentence with native TTS while ASR receives input | Source and simulated-event tests; real concurrency and echo exclusion pending |
| Voice guidance | Non-echo ASR text stops TTS; final input guides the continuing turn | Reasoning-preservation tests; actual host behavior pending |

`queued`, wake submission and network ACK are intermediate states. Delivery is accepted only after the exact session owner claims the original message. Its result must retain sessionId, ownerEpoch and claimToken. Disconnects, generation changes and uncertain writes require original receipt readback; never change the delivery ID or use a PC model as a substitute.

For cross-PC delivery, the original PC stores the sole request record; the device PC stores transport messages and receipts only. The original record is checked before reception, and the current signed connection verifies the caller. Public generation IDs and raw headers cannot establish device identity. See [exact delivery and formal replies](agent-endpoint-delivery_en.md).

## Configuration and upgrades

On mobile, open All-day Recording → Devices → Glasses → Glasses Settings → Current Persona. Select the PC that owns the device connection and mailbox explicitly. A persona may reside on another PC. Keep these references separate; never infer ownership from an old default task target.

Upgrade clients to the current contract. Retire old business grants, knowledge-tool allowlists and server business aliases without migrating old business configuration; retain old data in private backups. Preserve original message, identity and receipt keys when inspecting existing tasks; missing records do not authorize a new delivery.

## Acceptance steps

1. Upgrade the PC, Relay, phone and AIUI candidate; verify the actual generation, asset hashes and package versions.
2. Bind a persona and verify its instructions, Skills, default PC and mobile history on the next glasses turn; the model remains configured by Rokid.
3. With no persona, and with an enabled remote Agent lacking a Route binding, call APIs for another workspace and PC. Bindings must not restrict access.
4. Add an API on the target PC only. Keep Relay unchanged and confirm device discovery and invocation.
5. Deliver twice to the same glasses session and verify wake, claim, response and deduplication. Close the owner and verify honest queue/error state.
6. Speak during reasoning and during TTS. Verify concurrent ASR, speech-only interruption, final guidance of the same turn and absence of duplicate replies or echo input.
7. Exercise LAN, P2P and Relay separately, recording actual selection and fallback causes. Disconnect, restart and revoke connections without replaying uncertain writes.

## Related contracts

- [Device Agent integration](device-agent-adapter_en.md)
- [Exact delivery and formal replies](agent-endpoint-delivery_en.md)
- [Persona and device configuration HTTP](aiui-agent-profile-http_en.md)
- [Generic API transport](../apps/rabilink-aiui/docs/generic-api-transport_en.md)
- [Agent execution loop](../apps/rabilink-aiui/docs/agent-tool-contract_en.md)
- [Peer Tunnel](rabilink-peer-tunnel_en.md)
- [Relay deployment and responsibilities](rabilink-relay-server_en.md)

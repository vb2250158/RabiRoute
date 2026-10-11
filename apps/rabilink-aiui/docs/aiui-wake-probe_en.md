# Verify AIUI wakeup through a two-finger tap

English | [简体中文](aiui-wake-probe.md)

Status: experimental probe. Installation, startup and custom-message replies were verified on hardware; the system rejected an ordinary application publishing the two-finger broadcast, so that path cannot provide automatic wakeup. Actual AIUI wakeup and original-message claim remain unverified. The user-confirmed path is RabiPC delivery → phone triggers a two-finger tap → the configured Rokid custom instruction opens AIUI → AIUI claims the original message.

## Official basis

The user-provided [CXR-L documentation](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/fa92e9303bc848e6b4a20c062f2c792b.html) was read on 2026-10-10. “Glasses keys and system broadcasts” v1.2 names `com.android.action.ACTION_TWO_FINGER_SINGLE_TAP` as the two-finger single-tap action and documents receiving ordered broadcasts. “Custom commands” v1.3 describes communication with a custom glasses application in a `CUSTOM_APP` session.

These chapters establish event reception and application transport. The documented permission statement concerns broadcasts sent by the system to registered receivers; it does not establish permission for an ordinary application to publish them. On 2026-10-10, hardware returned `dispatch_security_rejected` for Android `sendOrderedBroadcast()`, corresponding to a system `SecurityException`; this path did not wake AIUI. `sendCustomCmd()` was verified to transport probe messages, not inject system keys. A supported gesture-trigger API or authorized system component remains to be established.

## Phone test

1. Configure the glasses two-finger single tap in the Rokid app to open the target AIUI.
2. Open the RabiLink Rokid CXR diagnostic page, connect and query the glasses component. For an update, enable phone Wi-Fi and wait for network readiness before explicitly installing the bundled component, then query installation again.
3. Start the component without capture and wait for its successful startup callback.
4. Select the experimental two-finger AIUI wake test. The component receives a CXR request with an operation ID and sends the fixed ordered broadcast. Active or pending capture rejects the test.
5. Observe whether AIUI opens and accepts a conversation. Preserve the phone receipts and actual glasses behavior. A broadcast receipt does not confirm that AIUI opened.

The slim phone version is `0.3.53-dev` (56); the bundled glasses component is `0.1.2` (3). Installation and probe execution are explicit. Each click creates a request ID, which the glasses persist before broadcasting. Repeated requests with that ID do not emit another gesture. The diagnostic ledger holds at most 128 IDs and rejects further entries without evicting old IDs. A 15-second timeout never automatically resends the probe.

`broadcast_submitted` means Android accepted the broadcast call; `broadcast_finished` means ordered broadcast dispatch finished. `duplicate_suppressed`, `capture_busy`, `ledger_full`, `ledger_failed` and `dispatch_failed` report duplicate requests, capture, full diagnostic storage, storage failure and broadcast failure. `dispatch_security_rejected` separately reports a system `SecurityException`; `dispatch_invalid_argument` reports `IllegalArgumentException`. The phone shows the cause while retaining the original attempted ID and never retrying automatically. None confirms receipt of a business message by AIUI.

On installation failure, distinguish Bluetooth/CXR readiness from file transfer: a Bluetooth connection does not prove that the phone joined the glasses hotspot. `onInstallAppResult=false` establishes failure only. If proxy logs report hotspot join failure, resolve the Wi-Fi link before inferring an APK signing issue.

## Ownership and subsequent integration

| Object or requirement | Execution owner | Acceptance evidence |
| --- | --- | --- |
| Gesture and custom instruction | Glasses system and saved Rokid configuration | Target AIUI visibly opens after the code trigger |
| CXR probe | Phone controller and custom glasses component | Broadcast-stage receipt with the same request ID |
| AIUI inference, ASR and TTS | Rokid AIUI host | Same host processes two messages and audibly responds |
| Original delivery and response | Existing Rabi message contract | Original message ID is claimed and actual response returned without duplicate execution |

The probe owns neither a model nor a new business queue and does not register an available complete Route Agent. Closing the phone diagnostic page disconnects its CXR controller; the glasses component starts no capture. RabiPC neither owns nor starts the AIUI model. Automatic delivery follows actual wakeup evidence and verified owner, claim and receipt contracts. Native tool-result continuation remains covered by the [tool contract review](agent-tool-contract_en.md).

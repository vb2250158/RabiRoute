English | [简体中文](README.md)

# AIUI to Rabi mobile BLE connectivity probe

Experimental package exchanging only `ping:<8 random hexadecimal digits>` and a matching `pong:` (13 bytes each). No audio, video, account details, business data, or public network is involved. A successful build does not establish device connectivity or background wakeup.

1. Update the Rabi mobile APK without clearing data. Installation interrupts running services; arrange a recording break first.
2. In the mobile advanced diagnostics center, open the glasses BLE test, grant Nearby devices permission, and keep the page foreground. Version 0.2 automatically advertises on entry; repeated starts do not recreate the running service.
3. Import this directory as an independent AIUI package and open interactive `pages/ping/index` on the glasses. Version 0.2 scans for four seconds once ready, connects only to a unique test phone, performs one ping/pong, and disconnects. Failures do not loop; retry via the button or confirmation key.
4. Only a matching pong shown by the glasses proves the round trip. The phone handing a response to its Bluetooth stack is insufficient.
5. Leaving either diagnostic page closes the link. The probe does not change official glasses pairing, recording settings, or business queues.

Service UUID: `78c20001-48a3-4b18-a401-819ec0200001`; characteristic UUID: `78c20002-48a3-4b18-a401-819ec0200001`. The AIUI client filters by service UUID and writes with response before reading a `number[]`. The phone rejects prepared writes, nonzero offsets, oversized input, and other content. The probe is not authenticated and must not carry private or business data.

The phone requests the new runtime `BLUETOOTH_ADVERTISE` permission without scanning other devices. Coexistence with the official glasses Bluetooth connection and current firmware support require device validation. AIUI discovery/connection requires an interactive page; this package does not provide background persistence.

The page preserves its last stage, result, lifecycle reason, and key code separately. Hide, unload, timeout, and explicit stop are distinguished; hiding does not overwrite a successful result. Host interaction gates and system permissions still apply. Multiple advertising test phones are rejected rather than guessed. Only retry is available while idle; the confirmation key never activates stop.

Version 0.3 first calls `getDevices()` for devices remembered by the runtime, not the system pairing list. Direct connection requires a unique match to the ID and service UUID saved after a prior successful nonce round trip; the service and nonce are verified again. First use, missing records, or ambiguous matches fall back to the service-filtered scan without connecting to other remembered devices. Full `name: message` errors retain the exact stage: S1 scan invocation, S2 awaiting the scan, S3 listener registration, S4 waiting for results, or S5 parsing a callback. This helps locate host QuickJS failures. Keep the existing v0.2 phone APK; no reinstall is required.

Phone sources are in `../rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RokidBlePing*.java`. Build and ZIP artifacts belong on the local machine, not the shared source directory.

After copying sources locally, run `node test-ping.mjs`. Run `node build.mjs <new-local-output-directory> <path-to-Write-DeterministicZip.mjs>` to generate the Studio directory and AIX. Reuse the ZIP writer from `../rabilink-aiui/scripts/Write-DeterministicZip.mjs`. Test the phone protocol with `:app:testDebugUnitTest --tests com.rabi.link.modules.rokid.RokidBlePingProtocolTest -PmobileSlim -ProkidVideo`.

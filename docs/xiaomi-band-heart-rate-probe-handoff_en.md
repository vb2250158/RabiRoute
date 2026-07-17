<!-- docs-language-switch -->
<div align="center">
English | <a href="./xiaomi-band-heart-rate-probe-handoff.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Xiaomi Band Heart-Rate History Probe Handoff

> Status: experimental investigation handoff. The APK probe and diagnostic evidence paths exist, but a complete, stable, user-authorized background API for heart-rate history has not been verified.

The Android probe has moved under the Rabi Link name:

```text
examples/android-rabi-link-probe/
package: com.rabi.link
export script: Export-RabiLinkProbeApk.ps1
```

## Current conclusions

- The project no longer treats the Band's live heart-rate broadcast as the main route; it requires user-side broadcast mode and is not suitable for ordinary background use.
- Xiaomi Health's local provider can expose the most recent heart-rate value to ADB shell, but this is not a complete history API.
- A normal third-party APK encounters signature/privileged/preinstalled permission barriers when accessing internal provider/service APIs.
- Health Connect permissions can be requested, but the tested Xiaomi Health environment did not publish heart rate, sleep, or steps there.
- Reverse-engineering evidence shows internal structures such as `DailyHrReport.hrRecords`, but the public provider does not expose that complete list.
- Xiaomi Health cloud SDK/OAuth remains the most plausible product route, but it requires partner credentials and has not been validated with a real authorized account.

## Route classification

| Route | Current result | Product background API? |
| --- | --- | --- |
| `heartrate/recent` provider | Latest value available to ADB shell; APK permission boundary remains | Latest-value probe only |
| Full/day history provider | Internal data structures exist; provider does not expose the list | No |
| Health Connect | Permission shape works; tested data sets were empty | Not currently usable |
| `HealthProviderService` | Signature/privileged/preinstalled permission | No |
| Xiaomi Health cloud SDK/OAuth | Needs partner `app_id` and OAuth token | Pending real validation |
| `DailyHrReport` logcat | Can capture chart data while the foreground heart-rate page runs | Diagnostic evidence only |
| Hidden “all records” page | Can be opened; tested page had no data | No |

## Diagnostic logcat path

The investigation found that opening the Xiaomi Health heart-rate page can emit a `DailyHrReport` containing chart `hrRecords`. A script can parse the log into JSON/CSV.

This path depends on a foreground page and logcat side effects. It must not be packaged as a RabiLink/RabiRoute background API and must not be described as reliable data access.

## Productization gate

A route qualifies for an upper-level API only if it:

- can be triggered by an authorized provider/service/Health Connect/cloud SDK contract;
- does not require foreground UI navigation, scrolling, screenshots, UI dump, or logcat side effects;
- returns full history or explicit pagination, not just the latest value;
- has a stable permission model that can be explained to ordinary users;
- provides data timestamps, units, source identity, and error semantics;
- passes real-device and account-region acceptance.

## Build and handoff

Use the scripts and commands under `examples/android-rabi-link-probe/` as the executable source of truth. Keep generated APKs, device dumps, decompiled applications, logs, account tokens, serial numbers, and personal health data out of Git.

The next useful investigation is the official/partner cloud route with valid authorization, followed by a comparison of completeness, delay, rate limits, user consent, and revocation. Do not spend product effort wrapping the logcat path unless the explicit goal is diagnostic evidence collection.

## Privacy boundary

Heart-rate history is sensitive health data. Collection must be opt-in, narrowly scoped, encrypted in transit/storage, revocable, and excluded from public examples and routine logs. RabiRoute should receive only the normalized data needed by an authorized workflow, not a bulk export by default.

# Phone location recording

English | [简体中文](mobile-location-recording.md)

The **Records** page combines audio, video and location. Choose Location in the type filter and open a row for its timestamp, place, coordinates and accuracy. The header shows location capture status and sampling interval. Tap that status, or open **Settings → Location recording / Records → Devices → Phone → Location recording**, to configure the Android key or export a day. This is experimental; builds, device checks and all-day endurance require separate acceptance.

## Use

1. Enable system location and grant permission. Precise permission improves tracks; approximate points retain their actual reported accuracy.
2. Start location-only recording, or enable location alongside all-day recording and start audio from Records. Switching to location-only asks before stopping current audio/video.
3. Pause using the all-day master switch. Disabling Amap stops only Amap requests; pausing all-day recording stops all capture. Pause before switching back to audio mode.
4. Browse dates and older/newer pages in Records; filter by phone source or location type. The location settings page shows the latest 200 points for a day, while GeoJSON export includes every point that day.

Defaults are a 60-second normal interval, a 5-second fastest interval and a 10-meter recording threshold. All three can be changed in location settings and applied immediately. Motion hints shorten the target interval to 15 seconds. A trustworthy location speed of at least 2 m/s, or sufficiently fast displacement after accounting for uncertainty, selects the fastest interval. The fastest interval cannot exceed the normal interval.

The low-power significant-motion sensor is preferred, with a low-rate accelerometer fallback. Without a usable sensor, location fixes drive adaptation. Gyroscope rotation is not travel speed. Motion hints expire after 90 seconds and fast-travel evidence after 60 seconds unless renewed. Fresh fixes accurate to 50 meters or better establish rest: after three quiet minutes the target interval becomes at least two minutes, and after ten quiet minutes at least five minutes. Missing or imprecise fixes eventually restore the normal interval. GPS speed can sustain fast sampling during constant-speed travel. Motion sensors shorten the next location wait; they cannot confirm displacement in meters on their own.

Acquisition, track storage and Amap place lookup are controlled separately. Saving requires displacement beyond the greater of the configured threshold and the combined accuracy of both fixes, with the fastest configured interval as the minimum storage spacing. Fresh stationary samples are retained about every five minutes. The 10-meter threshold does not promise 10-meter accuracy. The screen shows the target interval, motion source and straight-line distance between saved points. Actual delivery and battery use depend on Android, reception and power policy; an update interval does not guarantee GPS-chip duty cycling.

WGS84 coordinates, timestamps, accuracy and provider stay in private phone SQLite storage and work offline. Optional native speed and speed accuracy guide sampling but are not stored; uncertainty-adjusted displacement is used when speed is absent. Automatic PC/Relay upload and Agent track queries are not implemented.

The unified timeline reads the same SQLite database, including previously saved points, without creating duplicate record files. A location is an instantaneous sample: the ruler marks the point without claiming continuous coverage between fixes. Opening it does not start audio playback. Computer Archive currently contains audio only; select Local Records to view locations.

Location-only mode needs no microphone. The existing all-day foreground service maintains screen-off recording, subject to manufacturer power restrictions. Reopen the app after reboot or process termination to resume; automatic restart after force-stop is not promised.

## Android key and quota

Use an **Android-platform** key matching package `com.rabi.link` and the installed APK's signing SHA-1. Web-service keys do not apply. Android Keystore encrypts the phone-entered key; it is excluded from source, APKs, logs, exports and PC/Relay settings. An empty input retains the key; Clear deletes it and disables Amap queries.

Read the in-app notice and [Amap privacy policy](https://lbs.amap.com/pages/privacy/) before consenting to location, device, network and Wi-Fi/cell information processing. The SDK is initialized only after consent. System GPS needs no key.

A single Amap network fix supplies a place label only if it matches the original after coordinate conversion. Otherwise original coordinates stay unlabeled. Labels are cached within 150 meters. New queries are at least ten minutes apart; errors wait for later samples. System samples less accurate than 150 meters do not trigger queries.

As checked on October 26, 2026, [public Amap pricing](https://lbs.amap.com/pages/base_service_price) lists **1.5 million monthly basic-map/location requests**, including Android online location, and **150,000 monthly basic LBS requests** for verified individual developers. Categories share allowances; the account console determines entitlement and billing.

The phone defaults to **10,000 SDK starts per month**, counting failures and manual tests, using Beijing calendar months. One start every ten minutes for 31 days is approximately 4,464, before cache savings. This local SDK count is not an internal-network count or account bill and does not cover other devices. Reaching the cap stops Amap while system GPS continues; tracks remain stored.

## Implementation and verification

`RabiConversationService` is the sole capture owner. `LocationController` manages native listeners and stale callbacks. `LocationRepository` owns durable points, cache, transactional monthly accounting and streaming GeoJSON. `AmapLocationLookup` uses Android Location SDK 6.5.1 for bounded HTTPS single fixes, with no Web-service calls. This pure-location release fits the slim package budget.

Run Android unit tests and isolated `LocationInstrumentation` storage/encryption/concurrent quota checks. Live SDK validation requires a valid Android key, matching package/signature, network, permission and privacy consent. Separately verify location-only start/pause, background samples, offline storage, restoration and export. Synthetic samples do not prove GPS reception or all-day battery behavior.

October 26, 2026: `0.3.68-dev` (71) passed 294 Android unit tests, root `npm run build`, slim-package/signature validation and an in-place real-device install. Isolated device checks passed encrypted roundtrip, database reopen, GeoJSON coordinate order, cache and concurrent monthly caps. The phone received real positions and Amap place names. Location-only capture held location/dataSync foreground types; pausing removed location. All-day screen-off endurance, longer travel, manufacturer power policies and battery consumption still need sustained field testing.

Adaptive release `0.3.69-dev` (72) passed 304 unit tests, the full build and slim-package validation, and was installed on the device. Device checks confirmed sampling-setting persistence, significant-motion listener registration, the default 60-second status and a fresh stored location; audio and location recording were restored. Deterministic tests cover 5/15-second movement intervals, 2/5-minute rest intervals, accuracy filtering, expired motion hints, constant-speed travel and fixes without speed. Real walking transitions, prolonged screen-off battery use and sensor fallbacks still require field testing.

Unified timeline release `0.3.70-dev` (73) passed 304 unit tests, the full build and slim-package validation. Isolated device tests cover existing-point projection, bidirectional pagination across more than 200 points, equal-time mixed-kind cursors and place-label change notifications. The actual Records screen displayed previously saved location cards, and the location filter and detail view were verified on the device.

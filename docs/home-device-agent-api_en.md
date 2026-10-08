<div align="center">English | <a href="home-device-agent-api.md">简体中文</a></div>

# Home device and speaker Agent API

> Status: experimental integration with automated contract tests. Each real device and service still requires acceptance in the user's environment. The Manager Xiaomi Home plugin owns clients, policy settings, protected credentials and durable action receipts. Agents never read HA tokens or call HA services directly.

Discover the current Manager URL and verify `/meta` generation, instance and health as described in the [Agent guide](rabi-agent-interfaces_en.md). These paths reuse connection authentication: local Agents, authenticated WebGUI clients and registered remote Agents share the same business contract. Installation operations still execute locally.

## Discovery and invocation

`GET /api/agent/xiaomi-home/resources?includeActions=1` discovers all imported entities with their current actions. Entities are not a physical-device count: one vacuum can expose many sensors, buttons and settings. For one resource, use `GET /api/agent/xiaomi-home/entity-actions?resourceId=<encoded resourceId>`; plain resource reads remain available.

`GET /api/agent/xiaomi-home/health` separately reports HA connectivity, event monitoring and camera capture. Manager readiness does not prove HA connectivity or that every device is online.

1. `GET /api/agent/help` discovers the business operations. `GET /api/agent/xiaomi-home/capabilities` returns `schemaVersion=1`, actions with `argumentsSchema`, speech bindings and confirmation semantics. This argument catalog is not an identity or permission credential.
2. `GET /api/agent/xiaomi-home/resources` returns state, availability, capabilities and `stateVersion`. Read one resource at `/resources/<URL-encoded resourceId>`. Only invoke capabilities advertised by that resource; names alone do not identify a safe target.
3. POST the following to `/api/agent/xiaomi-home/action-requests` with a stable `Idempotency-Key` and the current `/meta` values in `x-rabiroute-expected-application-generation-id` and `x-rabiroute-expected-manager-instance-id`. Arbitrary HA services and extra fields are rejected.

```json
{
  "requestId": "speaker-demo-001",
  "resourceId": "home:ha:media_player.example_speaker",
  "capability": "home.speaker.speak@1",
  "arguments": {"text": "Smart home announcement test."},
  "expectedStateVersion": "use the just-read resource version",
  "reason": "user-requested announcement",
  "dryRun": true
}
```

Optional `requestId` is a correlation identifier, 1–128 characters from letters, digits, `.`, `_`, `:`, `-`; it does not replace the idempotency key. Keys use the same character set, 1–160 characters. Optional `reason` is limited to 500 characters and rejects control characters. `dryRun` must be boolean. Only dry runs avoid sending device services. After a rehearsal, use an independent action key for `dryRun=false`; never change a key's payload.

4. On timeout, generation change or uncertainty, first GET `/api/agent/xiaomi-home/action-requests?idempotencyKey=<URL-encoded original key>`. It returns `state=completed|in_progress|uncertain`, timestamps and any existing `receipt`. A 404 means no readable receipt exists, not proof that the device did nothing. Lookup is read-only and works with HA offline.

## Actions for all imported devices

`home.entity.action@1` uses the existing action POST, lifecycle identity, state version and durable idempotency receipts. It requires no per-device grant, control switch or additional key. Actions derive from the live HA service targets, entity feature filters, fields, limits and options. Buttons, numbers, selects, text values, structured notification actions, lights, fans, climate devices, media players and other entity domains use the same contract. Sensors without provider actions remain readable.

Read the target's `actions`, then copy its action name, revision and parameter schema:

```json
{
  "resourceId": "home:ha:number.example_volume",
  "capability": "home.entity.action@1",
  "arguments": {"action": "set_value", "actionRevision": "copy from action discovery", "parameters": {"value": 20}},
  "expectedStateVersion": "copy from the same resource read",
  "reason": "The user requested a volume change",
  "dryRun": true
}
```

Before execution, Manager rereads the target and services and verifies action existence, schema revision, numeric bounds and current options. HA selectors not fully translated remain in `providerSelector`; bounded JSON is validated further by HA. Discovery does not prove physical acceptance of every action. The resource pins the target: parameters cannot override `entity_id`, `device_id`, `area_id` or `target`. Global services without an entity target are not device actions. An `unknown` reading or a never-invoked action is distinct from being offline; advertised generic actions may initialize those settings. `unavailable` is rejected.

For Xiaomi notifications with `action params`, the parameter schema declares a positional `parameters.values` array. Manager validates count and integer/string/boolean types, then encodes JSON for the official integration. A one-string action uses `{"values":["actual parameter"]}`. Do not invent remote-control key codes, room IDs or protocols inside strings. HA room labels are not vacuum map room IDs; exposed room-information sensors can provide map room metadata.

Generic actions return `accepted/provider_acceptance`, not physical movement, cleaning or audible completion. Read states, sensors and receipts separately. Lost responses are never automatically resent. Existing simplified actions retain their readback semantics.

## Vacuum and audio/video limits

Manager also provides an [experimental Mi Home cloud file connection](vacuum-cloud-map_en.md), opened from Xiaomi Setup. The provider owns login and cloud credentials; authenticated Agents share read-only device and file APIs. Version-2 decoding supplies map coordinates and file pose snapshots with unverified freshness. A read-only position endpoint also queries the device property: empty values remain unavailable and sample units and freshness are unverified. Coordinate navigation and robot audio are not provided yet.

Start, pause, stop, return, locate, remote control and room/zone cleaning appear only when the current device and services expose them. Position sensors may be empty; spot cleaning does not establish navigation to a coordinate followed by stopping. Voice-pack downloads are not arbitrary TTS; camera switches are not playable audio/video streams. The official integration [does not provide vacuum map decryption, camera video streams or speaker conversation history](https://github.com/XiaoMi/ha_xiaomi_home/wiki/Features-that-will-not-be-implemented). Do not report coordinate navigation, microphone ingress or two-way calls as connected from those controls. Other integrations offering actual media streams require their corresponding media contracts.


## Actions

The catalog includes the existing 15 controlled light, switch, fan, cover, climate and vacuum actions, plus these media actions. Numbers and booleans must have the declared types; undeclared fields are rejected.

| Capability | Arguments | Availability / confirmation |
| --- | --- | --- |
| `home.speaker.speak@1` | Nonempty `text`, at most 1000 characters | Explicit binding; provider acceptance |
| `home.media.play@1` / `pause@1` / `stop@1` | None | Corresponding HA feature; state readback |
| `home.media.next_track@1` / `previous_track@1` | None | Corresponding feature; provider acceptance |
| `home.media.set_volume@1` | `volume`, 0–1 | Corresponding feature; volume readback with 0.02 tolerance |
| `home.media.mute@1` | Boolean `muted` | Corresponding feature; mute readback |
| `home.media.seek@1` | `positionSeconds`, 0–86400 | Corresponding feature; provider acceptance |
| `home.media.select_source@1` / `select_sound_mode@1` | `source` / `soundMode` | Currently advertised option; state readback |
| `home.media.play_media@1` | `url`, `mediaType` | PLAY_MEDIA feature; provider acceptance |

Media URLs are limited to 2048 characters and HTTP(S), without user credentials, query or fragment. Types are `music`, `url` or `audio/*`. Rabi passes the URL to HA/the player; it does not download, relay or convert local paths into device-accessible URLs. The target must be able to access it. Players without PLAY_MEDIA do not expose URL playback. Speech support does not imply arbitrary audio-file playback.

## Speech bindings

Under the current Route's Xiaomi Home settings, choose a speaker and its text-playback notification service, then save. Local `settings.json` is the single owner. Authenticated connections may also update complete settings through GET/PUT `/api/agent/xiaomi-home/settings`, with revision and lifecycle fence. `speechBindings` defaults to empty, allows at most 64 entries, and requires unique player and notification entities:

```json
{"mediaPlayerEntityId":"media_player.example_speaker","notifyEntityId":"notify.example_speaker_text","encoding":"json-array"}
```

`json-array` encodes one string as a JSON array so upstream YAML does not coerce words such as "yes" to booleans. Before invocation, the target must advertise exactly one string parameter. `text` is for ordinary text notifications and is rejected for structured targets with `action params`. Initial notification state `unknown` does not block bound speech; `unavailable` does. Unbound notification actions, including text directives, can use the generic entity-action contract when live discovery advertises them. Operators confirm purpose and ownership explicitly; bindings are not inferred from names.

## Receipts and failures

Normal POST responses are HTTP 202 with `code=0` and a receipt. `planned` means no execution; `accepted` confirms only service acceptance (`provider_acceptance`); `succeeded` confirms only target state readback (`state_readback`); `failed` means explicit rejection; `uncertain` means the outcome cannot be established. Speech, track changes, seek and media playback never infer audibility from playing state or notification timestamps. Audible completion requires real-device or user evidence.

400 indicates malformed requests; 403 forbidden capability/binding/source; 409 conflicting intent, in-progress or uncertain execution; 412 changed resource state; 404 missing resource/receipt; 503 unavailable service/receipt store. Lost capabilities, offline targets, invalid options and changed speech schemas create failed receipts without a service POST. Explicit HA 4xx rejections retain failed receipts. 5xx, disconnection and lost POST responses trigger read-only recovery, never automatic resend.

The full intent, including HA origin, resolved target/service, arguments, state version, rehearsal and reason, binds the durable key. Concurrent requests, rebuilt clients and Host restarts reuse receipts. Old receipts remain queryable; the new origin-bound digest differs from legacy digests, so resubmitting a legacy key conflicts instead of migrating it into a new execution. A proven state-version CAS rejection sent no action and permits the same key after refreshing the version. Other failed requests are not retried automatically; a corrected new action requires authorization and an independent key. Cancellation of dispatched services, acoustic completion callbacks and batch rollback are not provided.

Receipt storage/API contain no speech text, media URLs, HA tokens or local paths, only digests, targets, capabilities, times, state versions and confirmation. Public examples use placeholder entities; real bindings remain private runtime data. Stopping the service does not retract already dispatched actions.


## Device directory and UI

GET `/api/agent/xiaomi-home/devices` accepts no parameters and returns schemaVersion=1, observedAt, devices and unassignedResources. Devices group published resources by HA device registry ID with deviceId, displayName, model, manufacturer, areaName and resources. Same-name devices remain separate; unassigned entities are not represented as physical devices. A fixed read-only provider template reads registry metadata; no caller template endpoint or full identifier/credential list is exposed. Entity actions remain discovered live through entity-actions, without a second writer. The WebGUI [device list](user-guide/home-devices_en.md) shares the same action API, revisions and idempotent receipts. Browser receipt retention only restores queries.


## Shared manual remote control

Select Enter manual control below the map. When cleaning, the server calls HA pause and confirms paused before entering remote mode and waiting for initialization. An unconfirmed pause sends no direction. The official pv11cn v61 remote page only calls ENTER_REMOTE; this does not prove automatic firmware pause. Exit does not automatically resume cleaning; device return-to-dock behavior after exit needs physical verification.

With focus inside the panel, hold W to move forward, A to turn left, D to turn right; S stops. The verified protocol has no reverse command. Key release, focus leaving the panel and window blur send release. Touch users can hold direction buttons. Hiding the page, closing details or switching tabs exits remote mode. Video may lag; observe the physical robot. Provider acceptance does not prove physical stopping.

The shared prefix is `/api/agent/xiaomi-home/vacuum-remote`. GET `/capabilities?resourceId=...` returns current resource stateVersion, protocolRevision and directions. POST `/start` accepts `{resourceId,expectedStateVersion,protocolRevision}` and returns a session. POST `/pulse` accepts `{sessionId,expectedStateVersion,direction,durationMs}` with forward/left/right and 100–500ms. The verified model repeats direction every200ms while held; repeatIntervalMs is advertised in capabilities. Sends are serialized inside one absolute pulse deadline; slow replies never extend the window or replay expired repeat slots. Release runs in finally. Reverse, arbitrary codes and coordinates are rejected. POST `/stop` accepts `{sessionId}` and releases keys while retaining remote mode. POST `/exit` accepts `{sessionId}` and releases keys before exiting. GET `/status` selects sessionId for session status or idempotencyKey for the original receipt. Writes use current generation/instance fences and stable keys; timeouts query the original key without resending. Each result has a new stateVersion for the next pulse.

Manager VacuumRemoteController uniquely owns one remote session and serializes directional pulses. WebGUI, Codex and DSH share it and the same HA action receipts without owning HA credentials. Initialization, stop and exit coordinate so a late initialization cannot resurrect an exited session. Restart preserves historical receipts without replaying movement. Coordinate navigation remains unavailable.

Operators configure `vacuum-remote-bindings.json` in the Xiaomi component runtime directory:

```json
{"schemaVersion":1,"bindings":[{"resourceId":"home:ha:vacuum.example","watchdogResourceId":"home:ha:timer.example_remote_release"}]}
```

The binding selects an independent HA release timer, not an additional permission. Configure it for 7 seconds with restore=true; HA timer.finished and startup automations must send verified model release codes 2/4/6 and EXIT_REMOTE. Initialization and each pulse start this timer; confirmed release cancels it and failed release retains it. Unverified models, missing entities/actions or absent timers report unavailable. Old step scripts are retired as remote entry points; HA independent stop scripts remain solely for timer/startup compensation. Migrated callers use start/pulse/stop/exit.

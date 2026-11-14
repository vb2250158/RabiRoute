# Navigator API Reference

`navigator` is a runtime-provided global object. Its device-backed members
may depend on host support and declared agent permissions.

## `navigator`

| Member | Type | Behavior |
| --- | --- | --- |
| `id` | `string` | Opaque identifier scoped to the agent and device. Usually stable across ordinary restarts and upgrades, but can change if host identity material changes; empty without a current agent instance. Never treat it as a credential. |
| `renderingEnabled` | `boolean` | Whether this instance can render a visible interface. |
| `userAgent` | `string` | AIUI and Ink runtime identification string. |
| `language` | `string` | Preferred language, or an empty string if unavailable. |
| `languages` | `string[]` | Ordered language preferences. Match UI strings with IETF BCP 47 tags (e.g. `zh-CN`, `zh-TW`, `zh-HK`) using RFC 4647 Lookup semantics; distinguish Simplified/Traditional Chinese via script and region subtags. |
| `region` | `string` | Current region, or an empty string if unavailable. |
| `versions.ink` | `string` | Ink runtime version. |
| `versions.skia` | `string` | Skia version. |
| `onLine` | `boolean` | Read-only current online status; does not guarantee service reachability. |
| `connection` | `NetworkInformation` | Persistent EventTarget for connection type, quality, and change events; repeated access returns the same object. |
| `bluetooth` | `Bluetooth` | BLE client entry point; see [device APIs](./device.md). |
| `geolocation` | `Geolocation` | Location entry point; see [Geolocation API](./geo/geolocation.md). |
| `mediaDevices` | `MediaDevices` | Camera and microphone capture entry point; see [media APIs](./media.md). |
| `storage` | `StorageManager` | Persistent file storage entry point. |

## Network Information

| `navigator.connection` member | Meaning |
| --- | --- |
| `type: string` | `none`, `wifi`, `ethernet`, `cellular`, `bluetooth`, `other`, or `unknown`. |
| `effectiveType: string` | `slow-2g`, `2g`, `3g`, `4g`, or `unknown`; a quality estimate, not a cellular generation. |
| `downlink: number` | Estimated Mbps; `0` when unknown. |
| `rtt: number` | Estimated round-trip milliseconds; `0` when unknown, not a measurement of the current request. |
| `saveData: boolean` | Data-saving preference; defaults to `false`. |
| `change` | Event emitted when connection state updates; use `addEventListener` / `removeEventListener`. |

```javascript
function updateNetworkState() {
  console.log(navigator.onLine, navigator.connection.type);
}
updateNetworkState();
navigator.connection.addEventListener('change', updateNetworkState);
// During cleanup:
navigator.connection.removeEventListener('change', updateNetworkState);
```

Window `online` / `offline` events and App / Page `onNetworkStatus(event)` also
report changes; see [events](../events.md#network-status). Handle operation
errors even while online. HTTPS forwarded through a phone's Bluetooth link
may report `bluetooth`.

## Language Matching

When building multi-language UIs from `navigator.languages`, treat every entry as an IETF BCP 47 language tag (e.g. `zh-CN`, `zh-TW`, `zh-HK`). Walk the preference list in order; for each tag, match by progressively truncating trailing subtags (RFC 4647 Lookup: `zh-Hant-TW` → `zh-Hant` → `zh`), map Chinese variants via script/region subtags (`zh-Hans*`, `zh-SG` → Simplified; `zh-Hant*`, `zh-TW`, `zh-HK`, `zh-MO` → Traditional), and fall back to a default locale when nothing matches. Reference implementation: [`samples/navigator-info`](https://github.com/yodaos-project/AIUI/tree/main/samples/navigator-info).

## Device Methods

### `navigator.getDeviceSerialNumber()`

Returns a device serial number only to system agents when the host supplies it;
otherwise returns an empty string. Treat the value as sensitive device data.

### `navigator.getBattery()`

Returns `Promise<BatteryManager>`.
The Promise rejects when the host has no battery capability. See
[device APIs](./device.md) for battery methods and events.

### `navigator.requestDeviceToken(options?)`

Returns `Promise<DeviceToken>`. This method is available only to system agents; ordinary agents must not depend on it. Do not substitute the incorrect names `getDeviceToken()` or `hasDisplay` for current APIs.

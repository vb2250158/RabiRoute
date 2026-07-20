<!-- docs-language-switch -->
<div align="center">
English | <a href="./aiui-global-runtime-reference.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# AIUI Global Runtime APIs and RabiLink Usage Boundaries

This document records the global scope, window dimensions, timers, Base64, Fetch, and other globally mounted capabilities exposed by the AIUI QuickJS runtime, and explains their correct use in RabiLink.

## 1. Global Objects

AIUI follows web-style global-scope conventions:

```javascript
window === self;
self === global;
global === globalThis;
```

All four names refer to the same global object. New code should prefer `globalThis` when referring to the current runtime's global object and use `window` to read window dimensions. Do not attach business runtime state arbitrarily to the global object. Use `App.globalData` for the small amount of non-sensitive state shared across pages, and keep Page state on the Page instance.

## 2. Window Dimensions

| Property | Type | Description |
| --- | --- | --- |
| `window.innerWidth` | Number | Current inner window width in pixels |
| `window.innerHeight` | Number | Current inner window height in pixels |

RabiLink may first be hosted in a `448 x 150` card, after which the host can expand the same InkView into a `480 x 352` modal. Read the dimensions when a layout decision actually needs them. Do not cache them only once at module-load time, and do not mistake a size change for Page recreation.

Page layout should still prefer stable WXML/WXSS constraints. `innerWidth` and `innerHeight` are suitable for diagnostics, selecting a small number of layout states, or verifying a host resize. They are not suitable for polling in a high-frequency timer and repeatedly performing full-frame `setData()` updates.

## 3. Navigator Device Information

AIUI exposes the runtime version and device serial number through `navigator`:

| Member | Type | Description |
| --- | --- | --- |
| `navigator.userAgent` | String | Current device and runtime version information |
| `navigator.getDeviceSerialNumber()` | Function | Returns the current device's unique serial number |

```javascript
const serialNumber = navigator.getDeviceSerialNumber();
const userAgent = navigator.userAgent;

console.log("SN:", serialNumber);
console.log("UA:", userAgent);
```

Suitable uses:

- Associate a stable device identity with device management, runtime proof, and redacted cloud logs.
- Distinguish a physical device from the Craft browser debugging environment, which has no device serial number.
- Record the runtime version to help diagnose host compatibility.

Security boundaries:

1. A serial number is a stable device identifier and privacy-sensitive data. It is not a password, token, or trusted identity credential.
2. A client-submitted serial number alone must not authorize account login, application access, or external writes. The server must establish the binding through a token, one-time pairing, or another trusted process.
3. Ordinary HUDs and logs do not show the full serial number. Only the local first-run setup page, when it has no credential, may display the full serial number so that the device holder can complete binding in an authenticated management console. Server-side lists and ordinary troubleshooting records still use a redacted preview.
4. `userAgent` is useful for diagnostics and loose capability checks. Do not lock business logic to brittle full-string matches.
5. Check that `getDeviceSerialNumber()` exists and catch exceptions when calling it. Craft and other hosts may not provide a real serial number.

RabiLink currently stores the safely obtained result in its Page host policy: a physical-device serial number is used for the first-run setup page, binding matching, and the `deviceId` in glasses cloud logs; `unidentified-glasses` is used when it is absent. Whether native ASR starts still depends on the Page environment and host capabilities. The serial number only matches a short-lived claim window that was pre-authorized in the management console. Subsequent Relay requests are authenticated with a server-issued device token.

## 4. Timers

| API | Return value | Description |
| --- | --- | --- |
| `setTimeout(callback, delay?, ...args)` | Number | Run once after a delay; `delay` defaults to `0` milliseconds |
| `clearTimeout(timerId)` | - | Cancel a one-shot timer |
| `setInterval(callback, delay, ...args)` | Number | Run repeatedly at the specified interval |
| `clearInterval(intervalId)` | - | Cancel a repeating timer |

```javascript
const timerId = setTimeout(() => {
  console.log("Run after 2 seconds");
}, 2000);

// clearTimeout(timerId);
```

RabiLink rules:

1. Store timer IDs, callbacks, and host objects on the Page instance, not in JSON-serializable `data`.
2. `onHide()` pauses timers that should not continue in the background; `onUnload()` clears every timer.
3. When the Page becomes visible again, resume polling through an idempotent entry point. Never accumulate multiple intervals.
4. Do not drive the entire HUD with a high-frequency interval. Call the smallest possible `setData()` only when data actually changes.
5. Before a delayed callback runs, recheck the Page generation, visibility, and current mode so that an obsolete task cannot update new Page state.

## 5. Base64 Encoding and Decoding

| API | Description |
| --- | --- |
| `atob(encodedData)` | Decode a Base64 string into a string |
| `btoa(stringToEncode)` | Encode a Latin1-range string as Base64 |

```javascript
const encoded = btoa("Hello AIUI");
console.log(encoded); // SGVsbG8gQUlVSQ==

const decoded = atob(encoded);
console.log(decoded); // Hello AIUI
```

Note: `SGVsbG8gSlNVST==` in the official page does not correspond to `Hello AIUI`. The correct result of `btoa("Hello AIUI")` is `SGVsbG8gQUlVSQ==`.

`btoa()` accepts only the Latin1 range. Convert complete Unicode data to bytes with `TextEncoder`, then use a byte-to-Base64 procedure verified against the runtime. Base64 is encoding, not encryption; it must not be used to protect tokens, cookies, or user privacy.

## 6. Fetch Network Requests

```javascript
async function getData() {
  try {
    const response = await fetch("https://api.example.com/info");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log("Data:", data);
  } catch (error) {
    console.error("Request failed:", error);
  }
}
```

`fetch(url, options?)` returns a `Promise<Response>`. Common `options` include `method`, `headers`, and `body`.

### Response

| Member | Type | Description |
| --- | --- | --- |
| `ok` | Boolean | Whether the HTTP status is from 200 through 299 |
| `status` | Number | HTTP status code |
| `statusText` | String | Status description |
| `url` | String | Final response URL |
| `text()` | Promise<String> | Read the response text |
| `json()` | Promise<Any> | Read and deserialize JSON |
| `arrayBuffer()` | Promise<ArrayBuffer> | Read the binary response body |

Network rules:

1. `fetch()` does not necessarily throw for HTTP 4xx or 5xx responses. Always inspect `response.ok` or `status`.
2. `json()` can fail on an empty response or invalid JSON. The Relay adapter should distinguish HTTP failure, parse failure, and network failure in its records.
3. The documentation does not promise a complete browser networking API. The presence of `fetch()` does not imply that `AbortController`, a cookie jar, Service Workers, or browser cache policies are all available.
4. The Page must not log tokens, Authorization headers, raw ASR text, or complete private Agent replies.
5. If the PC is offline or the network fails, retain the local persistent queue first and then perform bounded retries. A transcription must not be lost because one Fetch request failed.
6. External writes still pass through the RabiRoute allowlist and action safety gate; the Page must not bypass them directly.

## 7. Other Global Mounts

The following objects are mounted both in the global scope and on `window`:

| Object | Purpose | RabiLink boundary |
| --- | --- | --- |
| `console` | Debug logging | Write only redacted events and states, never credentials or raw conversation content |
| `localStorage` | Local persistent storage | Store isolated queues and non-sensitive state; minimize sensitive values |
| `speechSynthesis` | Native speech synthesis | Speak in persistent pending-queue order and make TTS mutually exclusive with ASR ownership |
| `performance` | Performance monitoring | Diagnose long tasks, latency, and rendering problems; do not use it as a business clock |
| `TextEncoder` | Encode strings as bytes | Process UTF-8 requests, signature input, or binary protocols |
| `TextDecoder` | Decode bytes as strings | Decode binary responses such as `ArrayBuffer` |

The presence of these names in the global scope does not imply that they implement every browser extension interface. Use only methods supported by the AIUI official documentation and verified by physical-device probes.

## 8. Local Storage

AIUI provides a Web Storage API isolated per Agent. Keys and values in `localStorage` are strings and have no default expiration.

| Method | Return value | Description |
| --- | --- | --- |
| `getItem(key)` | String or `null` | Read a key |
| `setItem(key, value)` | - | Write a string; other types are automatically converted to strings |
| `removeItem(key)` | - | Delete a key |
| `clear()` | - | Clear all local storage for the current Agent |

```javascript
localStorage.setItem("username", "Rokid Agent");
const name = localStorage.getItem("username");

const user = { id: 1, name: "Admin" };
localStorage.setItem("userInfo", JSON.stringify(user));
const saved = JSON.parse(localStorage.getItem("userInfo") || "null");
console.log(saved?.name || "Not saved");
```

Isolation means that different Agents cannot read one another's storage directly. It does not mean the data is encrypted. Sensitive data must still be minimized and revocable, and kept out of logs, UI, exception messages, and ordinary settings objects.

### Glasses Device Credentials

RabiLink uses `localStorage` to store a server-issued `rbd_` device credential:

```text
Page has no usable token
  -> navigator.getDeviceSerialNumber()
  -> Enter RabiLink Setup and display the full serial number and Relay /manage address
  -> User signs in to the server console and binds the serial number to the target application
  -> Glasses poll POST /api/rabilink/devices/token
  -> Server returns an rbd_ device credential once
  -> Glasses store it in localStorage, isolated by Relay + serial number
  -> Later launches read the device credential directly and connect to Relay
```

The server stores only the serial-number hash, a redacted preview, and the device-credential hash. It does not store the full serial number or a directly usable device token. A binding can be claimed only once. If the local credential is lost or revoked, the user must perform "Bind / Reset" for the same serial number in the management console.

RabiLink storage rules:

1. Do not call `localStorage.clear()`, because it would also remove other state belonging to the same Agent.
2. When deleting a credential, call only `removeItem()` for the project's own device-credential key.
3. Isolate the key with a one-way local fingerprint of the Relay and serial number. Do not place the full serial number in the key name.
4. Keep the device credential separate from the application's primary token. Physical glasses ignore a primary application token injected by an outer Agent; only a Craft debugging environment with no device serial number retains compatibility.
5. When the server returns `401`, remove the invalid device credential and return to Setup, showing the serial number, management URL, and "Bind / Reset" steps.
6. Continue to isolate queues, cursors, cloud logs, and pending speech by the actual credential fingerprint so that rebinding cannot leak state between accounts.

## 9. RabiLink Conclusions

- Use `window.innerWidth/innerHeight` to observe the current surface, not as a replacement for the Page lifecycle.
- Use `navigator` for device identification and compatibility diagnostics. A serial number cannot replace a token or bypass the first trusted binding.
- Timers provide scheduling only. Every repeated task must be stoppable, resumable, and non-duplicating.
- Base64 has no security role.
- Fetch is the basis of Relay communication, but record-first behavior, a local persistent queue, and redacted logs remain mandatory.
- Use `localStorage`, `speechSynthesis`, `performance`, and encoding APIs through project adapters so that host differences do not spread through business code.
- `localStorage` stores only server-issued, revocable device credentials and project state. It does not persist a primary application token temporarily injected by an outer Agent.

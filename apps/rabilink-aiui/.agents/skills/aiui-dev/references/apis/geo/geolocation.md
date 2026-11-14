# Geolocation API Reference

## Permission

Declare location access in `app.json`:

```json
{ "permissions": ["GEOLOCATION"] }
```

## `navigator.geolocation`

The runtime supplies this object; agents do not construct it.

### `getCurrentPosition(success, error?, options?)`

Requests one position and reports it through callbacks. Returns `undefined`.
`success` is required; `error` and `options` are optional.

### `watchPosition(success, error?, options?)`

Returns a numeric watch ID and reports subsequent position changes. Release it with `clearWatch(watchId)`.

### `clearWatch(watchId)`

Stops the corresponding position watch.

Device location permission can still be denied after `GEOLOCATION` is declared
in the manifest. Handle failure callbacks for denial, temporary unavailability,
and timeout; clear watches when their owning Page or Widget stops needing them.

### Position options

| Field | Type | Meaning |
| --- | --- | --- |
| `enableHighAccuracy` | `boolean` | Prefer more accurate positioning; defaults to `false` and may use more power. |
| `timeout` | `number` | Maximum wait in milliseconds; omitted value is host-defined. |
| `maximumAge` | `number` | Maximum acceptable cached-position age in milliseconds; omitted value is host-defined. |

### Position result

`position.coords` contains numeric `latitude`, `longitude`, and `accuracy`
(meters), plus nullable `altitude`, `altitudeAccuracy`, `heading`, and `speed`.
`position.timestamp` is the acquisition time as a number.

Errors use codes `1` (`PERMISSION_DENIED`), `2` (`POSITION_UNAVAILABLE`), and `3` (`TIMEOUT`).

```javascript
const watchId = navigator.geolocation.watchPosition(
  (position) => {
    const { latitude, longitude } = position.coords;
    console.log(latitude, longitude);
  },
  (error) => console.error(error.code, error.message),
  { enableHighAccuracy: true, timeout: 10_000 },
);

// During cleanup:
navigator.geolocation.clearWatch(watchId);
```

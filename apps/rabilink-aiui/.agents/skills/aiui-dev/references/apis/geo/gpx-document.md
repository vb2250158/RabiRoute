# GPXDocument API Reference

## `GPXDocument`

Available globally and as a named export from `'gpx'`:

```javascript
import { GPXDocument } from 'gpx';
```

### Construction and parsing

- `new GPXDocument(input?)`
- `GPXDocument.from(input)`
- `GPXDocument.parse(input)`

Accepted input is GPX XML text, `Blob`, `ArrayBuffer`, a typed array/`BufferSource`, or another `GPXDocument`. `from()` and `parse()` have the same behavior.
Invalid GPX input throws; handle external or user-provided data with
`try...catch`. Passing an existing document creates an independent copy.
XML input must contain one complete `<gpx>...</gpx>` root. Truncated XML,
rootless route fragments, multiple GPX roots, and mismatched closing tags throw;
do not treat them as empty routes. Omitted input can still create a new document.

### Route methods

| Method | Result |
| --- | --- |
| `setStartPoint(point)` | Sets the start point. |
| `setEndPoint(point)` | Sets the end point. |
| `addWaypoint(point)` | Adds a waypoint. |
| `appendTrackPoint(point)` | Appends a track point. |
| `clearTrack()` | Removes track points but keeps start, end, and waypoints. |
| `toString()` | Returns GPX XML text. |
| `toBlob()` | Returns a Blob with `application/gpx+xml`. |

A point requires numeric `latitude` and `longitude`; optional fields are `elevation`, `time`, and `name`. Read-only `bounds` is `null` when there are no points, otherwise it contains minimum and maximum latitude/longitude.

```javascript
const route = new GPXDocument();
route.setStartPoint({ latitude: 30.2741, longitude: 120.1551 });
route.appendTrackPoint({
  latitude: 30.2792,
  longitude: 120.1618,
  time: new Date().toISOString(),
});
const xml = route.toString();
```

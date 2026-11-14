# Agent Worker API Reference

Read [Agent Worker development](../framework.md#agent-worker-development) for
`app.json.agentWorkers`, triggers, lifetime, and entry scripts. The runtime
creates the instance; `new AgentWorker()` is unsupported. Default-exported
fields and methods are copied to it and are available through `this`.

## Instance members

| Member | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Declared Worker name. |
| `navigator` | `WorkerNavigator` | Environment data and available Worker capabilities. |
| `close()` | `() => void` | Requests that this Worker stop. |
| Custom fields and methods | `any` | Members copied from the default export. |

`name`, `navigator`, and `close` are reserved and cannot be replaced by the
default export. Instance state survives repeated opens while the Worker runs,
but a restart creates a fresh instance. Persist durable values in storage.
`close()` does not interrupt the current function; return after calling it.

## `onOpen(event)`

Called on each successful Page or Widget open. Events queue while the entry
module loads and are delivered in order. Overlapping asynchronous work is not
merged automatically. The callback's return value is ignored.

`event` is an `ExtendableEvent` with `type: 'open'`; `target` and
`currentTarget` refer to the Worker global object. It inherits `Event` and
adds `waitUntil(value)`, which waits for `Promise.resolve(value)`. Call
`waitUntil()` during synchronous event dispatch; a later call throws
`InvalidStateError`. Declaring `onOpen` as `async` does not extend its lifetime.

```javascript
export default {
  pending: null,
  onOpen(event) {
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    event.waitUntil(this.pending);
  },
  async refresh() {
    // Update Worker state here.
  },
};
```

## Worker global scope and navigator

`self` and `globalThis` refer to `AgentWorkerGlobalScope`, which is an
`EventTarget`. Use `self.addEventListener('open', listener)` and
`self.removeEventListener('open', listener)` if using global listeners;
`AgentWorker` itself is not an `EventTarget`. Global `close()` requests a stop.
`self` is distinct from `this` inside `onOpen()`.

`this.navigator` is the global Worker `navigator`. `WorkerNavigator` provides
`id`, `renderingEnabled`, `versions`, `userAgent`, `language`, `languages`, and
`region`. Do not assume a Page's `window`, `document`, `fetch`, routing,
rendering, or media capture exists in the Worker.

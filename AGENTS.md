# Notes for agents

Homebridge plugin for GVM BLE lights. [README.md](./README.md) covers setup, the source
layout, and the release procedure - follow it. This file collects what is not obvious
from the code and has already cost debugging time.

## Working on the code

- `npm run build`, `npm run lint` (`--max-warnings=0`) and `npm test` must pass. The
  tests don't need a light or an adapter.
- Every noble `*Async` call must be wrapped in `withTimeout()` from `src/util.ts`; they
  are promisified events that never settle if the event doesn't arrive.
- Reconnection is driven by rediscovery: a handler that is `idle` waits for the
  peripheral to be advertised again. Anything that stops the light from advertising
  therefore wedges the plugin for good.
- Homebridge logs are in `~/.homebridge/homebridge.log`. Filter out the periodic
  `Not every device is connected` / `Already scanning` lines first - they are the
  watchdog confirming that scanning is running, not the problem itself. Look at what
  happened right before the last `Scan started`.

## Bluetooth / noble quirks (macOS)

- `@abandonware/noble`'s macOS bindings do **not** implement `cancelConnect`.
  `peripheral.cancelConnect()` settles the pending connect promise and then throws
  `this._bindings.cancelConnect is not a function`. Never put it in the same `try` as
  the disconnect that must follow it (see `abort()` in `src/platformAccessory.ts`).
- CoreBluetooth never times out a pending `connectPeripheral`. If our own timeout fires
  and the OS connection isn't cancelled via `disconnectAsync()`
  (`cancelPeripheralConnection`), the connect completes later behind our back. A
  connected GVM light stops advertising, so it is never discovered again - the plugin
  scans forever and only a Homebridge restart or power-cycling the light helps.
  The watchdog (`healthCheck()`) also releases an `idle` handler whose peripheral is
  still `connected`/`connecting` at the OS level as a safety net.
- After the adapter reports `resetting`/`poweredOff`, every peripheral handle is dead
  and CoreBluetooth silently drops calls made on them. Don't disconnect them, just
  `invalidate()` and wait for `poweredOn` (see `onAdapterStateChange`).
- `scanning` is only set from noble's `scanStart`/`scanStop` events, never guessed.
- The lights write without response and drop what they can't keep up with; commands are
  paced and ordered (`On` first) - see the 1.4.0 changelog entry before touching the
  commit queue.

## Releasing

Follow the *Release* section of the README: move the `Unreleased` notes in
[CHANGELOG.md](./CHANGELOG.md) under the new version, commit, then `npm version <patch|minor|major>`,
`npm publish`, `git push --follow-tags`, and create a GitHub release with the changelog entry.
Every fix that took real debugging should get a changelog entry explaining the cause, not
just the symptom, and a note in this file if it is a reusable gotcha.

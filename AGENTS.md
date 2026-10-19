# Notes for agents

Homebridge plugin for GVM BLE lights. [README.md](./README.md) covers setup, the source
layout, and the release procedure - follow it. This file collects what is not obvious
from the code and has already cost debugging time.

## Working on the code

- `npm run build`, `npm run lint` (`--max-warnings=0`) and `npm test` must pass. The
  tests don't need a light or an adapter; `test/noble-lifecycle.mjs` runs a light
  against noble's real JS layer (`@stoprocent/noble/lib/noble.js`) on fake bindings;
  `test/protocol.mjs` parses frames captured from a real light - add new captures there.
- The BLE library is `@stoprocent/noble` because it ships prebuilt binaries;
  `@abandonware/noble` (used up to 1.4.2) was compiled with node-gyp on every install
  and upgrade. Don't switch to a dependency that needs a compiler.
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

- CoreBluetooth never times out a pending `connectPeripheral`. If our own timeout fires
  and the OS connection isn't cancelled (`cancelPeripheralConnection`), the connect
  completes later behind our back. A connected GVM light stops advertising, so it is
  never discovered again - the plugin scans forever and only a Homebridge restart or
  power-cycling the light helps. `peripheral.cancelConnect()` does the OS cancel and
  marks the peripheral `disconnected` - but only while it is `connecting`, so `abort()`
  in `src/platformAccessory.ts` still disconnects anything else. (`@abandonware/noble`'s
  macOS bindings didn't implement `cancelConnect` at all and threw, which is why it
  has its own `try`.) The watchdog (`healthCheck()`) also releases an `idle` handler
  whose peripheral is still `connected`/`connecting` at the OS level as a safety net.
- After the adapter reports `resetting`/`poweredOff`, every peripheral handle is dead
  and CoreBluetooth silently drops calls made on them. Don't disconnect them, just
  `invalidate()` and wait for `poweredOn` (see `onAdapterStateChange`). noble drops its
  peripherals then (rediscovery creates new objects) and first emits `disconnect` for
  each of them, *before* `stateChange` - so the plugin's own adapter state is still
  `poweredOn` inside a `disconnect` handler. Anything that talks to the adapter from
  there has to be deferred (see `onDisconnected()`).
- noble's constructor installs a `warning` listener that `console.warn`s everything
  outside of the Homebridge log; the platform replaces it with a debug log.
- `scanning` is only set from noble's `scanStart`/`scanStop` events, never guessed.
  The one exception is `restartScanning()`: CoreBluetooth can stop scanning silently
  (seen after the Mac slept) and then no `scanStop` ever arrives, so the watchdog
  restarts a scan that produced no `discover` event at all for `STALE_SCAN_AFTER`.
- noble emits `discover` only once per peripheral per scan session (`allowDuplicates`
  is off). An advertisement ignored while the handler was busy is therefore not
  repeated until the scan is restarted.
- A terminal (and anything it spawns, e.g. a quick noble test script) gets adapter
  state `unauthorized` unless the terminal app has Bluetooth permission in System
  Settings. Check that before concluding the light is not advertising.
- The Homebridge service itself gets `unauthorized` when the `node` running it has no
  Bluetooth permission; as a launchd service it never sees the prompt. TCC stores the
  client path plus a code requirement. For an unsigned binary (Homebrew's `node`) that
  requirement is its `cdhash`, so every `brew upgrade` revokes the permission silently
  and it only shows after the next restart. Official nodejs.org builds get a Developer ID
  requirement (team `HX7739G8FX`) that covers later builds at the same path. TCC records
  the resolved binary (`process.execPath`, e.g. `/usr/local/Cellar/node@22/<version>/bin/node`),
  not the `/usr/local/opt` symlink in the launchd plist. Granting access emits no
  `stateChange`: Homebridge has to be restarted. With Full Disk Access for the terminal,
  `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "select client, auth_value
  from access where service='kTCCServiceBluetoothAlways'"` lists the grants (2 = allowed).
  The service therefore runs the signed build at
  `/Library/Application Support/Homebridge/node-x86_64/bin/node`, the layout hb-service's
  Node.js updater supports. It has its own global prefix: install a test build into the
  running Homebridge with *its* npm (`PATH="/Library/Application Support/Homebridge/node-x86_64/bin:$PATH"
  npm install -g <tgz>`) - Homebrew's npm installs into `/usr/local/lib/node_modules`,
  which the service doesn't load.
- The lights write without response and drop what they can't keep up with; commands are
  paced and ordered (`On` first) - see the 1.4.0 changelog entry before touching the
  commit queue.
- The full status report is `4c54 09 0020 03 <on> <channel> <brightness> <temp> <crc16>` -
  one byte per register `0x00`-`0x03` (`Register` in `src/bufferHelper.ts`), nothing more
  (checked on raw frames). The light sends it unprompted every ~5 s; it is *not* the reply
  to `infoAll()`, which is answered with `53 00 00 02 20 38` (presumably the 3200-5600 K
  range) - but not reliably: right after connecting it answered only ~2 of ~15 times, the
  watchdog's later probes nearly always. Since the status reports are echoed the light never
  goes quiet, so the probe and its answer are rare. Register `0x01` is the channel selected
  on the light. Changing the channel on the
  light drops the BLE link; the light advertises again ~1 min later and rediscovery
  reconnects it.
- What the official GVM app does (PacketLogger capture, 2026-10-19): it answers every status
  report within ms with the same values and `48` in place of `03` (`heartbeatReply()`). It
  writes the channel like any other register (`57 00 01 01 <n>`) and the link stays up.
  Its scenes are presets stored in the app, sent as plain register writes, preceded by
  `57 00 06 01 01`, which the light never confirms. To capture again: Apple's *Bluetooth
  logging profile* is required, without it PacketLogger saves an empty trace.

## Releasing

Follow the *Release* section of the README: move the `Unreleased` notes in
[CHANGELOG.md](./CHANGELOG.md) under the new version, commit, then `npm version <patch|minor|major>`,
`npm publish`, `git push --follow-tags`, and create a GitHub release with the changelog entry.
Every fix that took real debugging should get a changelog entry explaining the cause, not
just the symptom, and a note in this file if it is a reusable gotcha.

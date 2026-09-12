# Changelog

All notable changes to this plugin are documented here.

## 1.4.1

### Fixed

- The light was never found again after a connect attempt timed out on macOS,
  leaving the plugin scanning forever (`Not every device is connected, making
  sure we are scanning` / `Already scanning` every poll) until Homebridge was
  restarted or the light was power-cycled.

  The macOS bindings of `@abandonware/noble` do not implement `cancelConnect`;
  the call threw and the disconnect that should have followed was skipped. As
  CoreBluetooth never times out a pending connect on its own, it completed
  behind the plugin's back and the connected light stopped advertising.
  Failed connects now always cancel the pending OS connection, and the
  watchdog releases a peripheral that is still connected at the OS level while
  the plugin considers it idle.

## 1.4.0

### Fixed

- Brightness and color temperature were lost when HomeKit switched the light on
  (scene, automation or "turn on" with a remembered state). HomeKit writes the
  characteristics of one request separately and deliberately writes `On` last,
  assuming the accessory remembers what it received while it was off. GVM lights
  acknowledge those values but restore their own latched output while powering
  on, so everything written before the `On` was dropped and the only way to get
  the value to stick was to change it to something else and back.

  Writes are now collected for a moment and committed in an order the light
  honours: `On` first, then color temperature and brightness once the light has
  settled. Switching on always re-asserts both values, and values written while
  the light is off are re-applied on the next power-on.

### Changed

- Commands are paced instead of being pushed into a single connection interval,
  since they are written without a response and the light silently drops what it
  cannot keep up with.
- State reports coming from the light no longer overwrite a value that is still
  waiting to be written, which used to make the HomeKit slider jump back to the
  old value right after the user moved it.

### Added

- Homebridge v2 is declared as supported (`engines.homebridge`).
- `npm test` checks the order and pacing of the commands a HomeKit write
  produces, without needing a light or a Bluetooth adapter.

## Version history

- 1.3.0 fix: device stops responding after a Bluetooth adapter reset, all BLE calls are now bounded by a timeout and reconnection is watchdog-driven
- 1.2.9 fix: try fix BLE device refuse to connect 5
- 1.2.8 fix: color range restriction
- 1.2.7 fix: color space restriction
- 1.2.6 fix: color space
- 1.2.5 fix: color int type
- 1.2.4 fix: color range range
- 1.2.3 fix: color range specify
- 1.2.2 chore: more log
- 1.2.1 fix: temp range is not correct
- 1.2.0 fix: try fix brightness out of control when color temperature is out of range
- 1.1.15 fix: try fix BLE device refuse to connect 4
- 1.1.14 fix: try fix BLE device refuse to connect 3
- 1.1.13 fix: try fix BLE device refuse to connect 2
- 1.1.12 fix: fix BLE device refuse to connect
- 1.1.11 fix: a bug stops reconneceting to device after reset try 3
- 1.1.10 fix: a bug stops reconneceting to device after reset try 2
- 1.1.9 fix: a bug stops reconneceting to device after reset (Homebridge YOU SHOULD DOCUMENT LIFETIME PROPERLY!!!)
- 1.1.8 fix: stops working after 10 reconnection Homebridge limitation
- 1.1.7 fix: sometime device no response after interal state change of BLE server

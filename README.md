<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# GVM BLE (Bluetooth) Lights Plugin for Homebridge

## Supported Features
- Turn on/off the light
- Set the brightness of the light
- Set the color temperature of the light

## Not Supported Features
- Channel control (I have got only one channel light, so I can't test this feature)
- Scene control
  
## Usage
- identify the id of your light, put it in the config file
- or you have only one BLE light named `BT_LED`, you can use the default config file
exapmle:
```json
{
    "devices": [
        {
            "name": "GVM LED"
        }
    ],
    "platform": "gvm-ble-lights"
},
```

- whitelist node for BLE accesss
  - macOS:
    - head to Preferences -> Security & Privacy -> Privacy -> Bluetooth
    - add node to the whitelist
  - linux:
    - [check here](https://www.npmjs.com/package/@abandonware/noble#linux)
  - windows: 
    - [check here](https://www.npmjs.com/package/@abandonware/noble#windows)


### mutiple devices
for mutiple devices, id must be specified:
```json
{
    "devices": [
        {
            "name": "GVM LED",
            "id": "some uuid"
        }
    ],
    "platform": "gvm-ble-lights"
},
```
this id can be found in the log when `devices` is not specified.

### advanced options
both are optional and in milliseconds:
```json
{
    "devices": [
        {
            "name": "GVM LED"
        }
    ],
    "pollInterval": 15000,
    "timeout": 10000,
    "platform": "gvm-ble-lights"
},
```
- `pollInterval` (default `15000`): how often every light is checked for being alive. A light that stopped
  answering is disconnected and looked for again.
- `timeout` (default `10000`): how long a single Bluetooth operation may take before it is considered failed.
  Increase it if your light is far away and connecting keeps timing out.


## Known Issues
- Some communication protocal with the light is still unknown

## Version history
see [CHANGELOG.md](./CHANGELOG.md)

---

# Development

Node.js 18 or later is required. The plugin is written in [TypeScript](https://www.typescriptlang.org/);
the repo ships settings for [VS Code](https://code.visualstudio.com/) and ESLint, so install the
[ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) if you use it.
For everything HomeKit related, the [Homebridge developer documentation](https://developers.homebridge.io/)
lists all supported services and their characteristics.

```shell
npm install     # install dev dependencies
npm run build   # compile src/ into dist/
npm test        # checks the order/pacing of the BLE commands, no light or adapter needed
npm run lint
```

### Source layout
- [`src/platform.ts`](./src/platform.ts) - discovery, connection lifecycle and the watchdog.
- [`src/platformAccessory.ts`](./src/platformAccessory.ts) - one light: HomeKit characteristics, the
  commit queue and the notification parsing.
- [`src/bufferHelper.ts`](./src/bufferHelper.ts) - the BLE frames (`4c 54 …` + CRC16/XMODEM).
- [`config.schema.json`](./config.schema.json) - what the Homebridge UI offers, see the
  [config schema documentation](https://developers.homebridge.io/#/config-schema).

### Run it against Homebridge
Make the local checkout visible to your global Homebridge installation and start it in debug mode:

```shell
npm link
homebridge -D
```

To rebuild and restart Homebridge on every change, add the platform to `~/.homebridge/config.json`
and run `npm run watch`:

```json
{
  "platforms": [
    {
      "name": "GVM BLE lights",
      "platform": "gvm-ble-lights"
    }
  ]
}
```

The Homebridge startup command can be adjusted in [`nodemon.json`](./nodemon.json). Stop other running
Homebridge instances first, they conflict over the Bluetooth adapter and the HAP port.

### Release
Given `MAJOR.MINOR.PATCH`: bump *MAJOR* for breaking changes, *MINOR* for new functionality and
*PATCH* for backwards compatible fixes. Move the `Unreleased` section of
[CHANGELOG.md](./CHANGELOG.md) under the new version first, then:

```shell
npm version minor        # or major / patch - commits and tags the bump
npm publish              # runs lint, build and the tests through prepublishOnly
git push --follow-tags
```

A GitHub release with the changelog entry should be created for every published version.

Beta builds can be published for testing before a real release:

```shell
npm version prepatch --preid beta   # e.g. 1.4.1-beta.0
npm publish --tag=beta              # installable with @beta
```

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


## Known Issues
- Some communication protocal with the light is still unknown

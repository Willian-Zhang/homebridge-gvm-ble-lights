import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HttpLights } from './platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class ExamplePlatformAccessory {
  private service: Service;
  private ip: string;


  constructor(
    private readonly platform: HttpLights,
    private readonly accessory: PlatformAccessory,
  ) {

    this.ip = this.accessory.context.device.ip

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

  }

  async setOn(value: CharacteristicValue) {
    const url = `http://${this.ip}/light/${value ? 'on' : 'off'}`
    // const url = `http://${this.ip}/setState?type=switch&value=${value ? '1' : '0'}`

    try {
      await fetch(url, {
        signal: AbortSignal.timeout(500)
      })
      this.platform.log.info(this.accessory.displayName, 'Set Characteristic On ->', value);

    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Set Characteristic On Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    const url = `http://${this.ip}/light/status`

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(500)
      })
      const val = await res.text()
      const isOn = val === "1"
      this.platform.log.info(this.accessory.displayName, 'Get Characteristic On ->', isOn);

      return isOn;
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Get Characteristic On Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setBrightness(value: CharacteristicValue) {
    const url = `http://${this.ip}/light/brightness?value=${value}`
    this.platform.log.info(this.accessory.displayName, 'Set Characteristic Brightness', url);
    try {
      await fetch(url, {
        signal: AbortSignal.timeout(500)
      })
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Set Characteristic Brightness Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getBrightness(): Promise<CharacteristicValue> {
    const url = `http://${this.ip}/light/brightness_value`

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(500)
      })
      const val = await res.text()
      this.platform.log.info(this.accessory.displayName, 'Get Characteristic Brightness ->', val);

      return val
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Get Characteristic Brightness Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

}

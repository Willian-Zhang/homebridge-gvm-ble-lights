import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HttpLights } from './platform.js';

export class HttpLightAccessory {
  private service: Service;
  private url: string;

  constructor(
    private readonly platform: HttpLights,
    private readonly accessory: PlatformAccessory,
  ) {

    this.url = `http://${this.accessory.context.device.ip}/`;


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

    setInterval(() => {
      fetch(this.url, {
        signal: AbortSignal.timeout(800),
      })
        .then(res => res.json())
        .then(res => {
          const { on, brightness } = res;
          this.service.updateCharacteristic(this.platform.Characteristic.On, on);
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
        })
        .catch(e => this.platform.log.error(this.accessory.displayName, 'Error polling device updates', e));
    }, 2000); // TODO read interval from settings

  }

  async setOn(value: CharacteristicValue) {
    try {
      await fetch(this.url, {
        signal: AbortSignal.timeout(800), //TODO read timeout from context
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ on: value }),
      });
      this.platform.log.debug(this.accessory.displayName, 'Set Characteristic On ->', value);
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Set Characteristic On Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.timeout(800),
      });
      const { on } = await res.json();
      this.platform.log.debug(this.accessory.displayName, 'Get Characteristic On ->', on);
      return on;
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Get Characteristic On Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setBrightness(value: CharacteristicValue) {
    try {
      await fetch(this.url, {
        signal: AbortSignal.timeout(800),
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ brightness: value }),
      });
      this.platform.log.debug(this.accessory.displayName, 'Set Characteristic Brightness', value);
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Set Characteristic Brightness Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getBrightness(): Promise<CharacteristicValue> {
    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.timeout(800),
      });
      const { brightness } = await res.json();
      this.platform.log.debug(this.accessory.displayName, 'Get Characteristic Brightness ->', brightness);
      return brightness;
    } catch (e) {
      this.platform.log.error(this.accessory.displayName, 'Get Characteristic Brightness Error:', e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

}

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HttpLights } from './platform.js';

export interface HttpLightAccessoryConfig {
  url: string;
  timeout: number;
  pollInterval: number;
}

export class HttpLightAccessory {
  private service: Service;

  constructor(
    private readonly platform: HttpLights,
    private readonly accessory: PlatformAccessory,
    private readonly config: HttpLightAccessoryConfig,
  ) {

    this.platform.log.info(`Initializing accessory ${this.accessory.displayName} with config ${JSON.stringify(config)}`);


    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    setInterval(() => {
      fetch(this.config.url, {
        signal: AbortSignal.timeout(this.config.timeout),
      })
        .then(res => res.json())
        .then(res => {
          const { on, brightness } = res;
          this.service.updateCharacteristic(this.platform.Characteristic.On, on);
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
        })
        .catch(e => this.platform.log.error(this.accessory.displayName, 'Error polling device updates', e));
    }, this.config.pollInterval);

  }

  async setOn(value: CharacteristicValue) {
    try {
      await fetch(this.config.url, {
        signal: AbortSignal.timeout(this.config.timeout),
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
      const res = await fetch(this.config.url, {
        signal: AbortSignal.timeout(this.config.timeout),
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
      await fetch(this.config.url, {
        signal: AbortSignal.timeout(this.config.timeout),
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
      const res = await fetch(this.config.url, {
        signal: AbortSignal.timeout(this.config.timeout),
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

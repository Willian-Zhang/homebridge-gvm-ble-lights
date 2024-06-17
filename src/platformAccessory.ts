import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HttpLights } from './platform.js';

export class HttpLightAccessory {
  private service: Service;
  private topic: string;

  private on: boolean = false;
  private brightness: number = 100;

  constructor(
    private readonly platform: HttpLights,
    private readonly accessory: PlatformAccessory,
    // private readonly config: HttpLightAccessoryConfig,
  ) {

    this.topic = 'devices/' + this.accessory.displayName
    this.platform.log.info('Created accessory with topic', this.topic)


    // this.platform.log.info(`Initializing accessory ${this.accessory.displayName} with config ${JSON.stringify(config)}`);


    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    // this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    this.platform.mqttClient.on('message', (topic, payload) => {
      if (topic === 'devices') {
        const { id, state } = JSON.parse(payload.toString())
        if (id === this.accessory.displayName) {
          const { on, brightness } = state;
          this.on = on;
          this.brightness = brightness;
          this.service.updateCharacteristic(this.platform.Characteristic.On, on);
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
        }
      }
    })
  }

  updateState(on: boolean, brightness: number) {
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
  }

  async setOn(value: CharacteristicValue) {
    this.platform.mqttClient.publish(this.topic, JSON.stringify({ on: value }))
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.on
  }

  async setBrightness(value: CharacteristicValue) {
    this.platform.mqttClient.publish(this.topic, JSON.stringify({ brightness: value }))
  }

  async getBrightness(): Promise<CharacteristicValue> {
    return this.brightness
  }

}

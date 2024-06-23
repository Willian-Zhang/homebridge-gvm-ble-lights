import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { BleLights } from './platform.js';
import { Characteristic, Peripheral, ServicesAndCharacteristics } from '@abandonware/noble';

export class BleLightAccessory {
  private service: Service;

  private on: boolean = false;
  private brightness: number = 100;

  private set_on_characteristic: Characteristic | undefined;
  private set_brightness_characteristic: Characteristic | undefined;

  constructor(
    private readonly platform: BleLights,
    private readonly accessory: PlatformAccessory,
    private readonly peripheral: Peripheral,
  ) {

    const on_characteristic_uuid = 'd00b8ba4d8ce42ff92f2b0d193c58da4';
    const set_on_characteristic_uuid = '19380250824b46c797a979761b8a27a7';
    const brightness_characteristic_uuid = '127cf8c9b7fe47e3b2e03901b7988b00';
    const set_brightness_characteristic_uuid = '66286dbfe5e946d4b300a0ec456f677c';

    peripheral.connectAsync()
      .then(() => this.platform.log.info("Peripheral connected", peripheral.id))
      .then(() => peripheral.discoverAllServicesAndCharacteristicsAsync())
      .then(({ characteristics }: ServicesAndCharacteristics) => {
        this.set_on_characteristic = characteristics.find(chr => chr.uuid === set_on_characteristic_uuid);
        this.set_brightness_characteristic = characteristics.find(chr => chr.uuid === set_brightness_characteristic_uuid);

        const on_characteristic = characteristics.find(chr => chr.uuid === on_characteristic_uuid);
        if (on_characteristic) {
          on_characteristic.subscribe();
          this.platform.log.info('Subscribed to peripheral "on" characterisitic', peripheral.id)
          on_characteristic.on('data', buff => {
            const on = buff.readInt8() === 1;
            this.on = on;
            this.platform.log.debug('received on update', this.peripheral.id, on);
            this.service.updateCharacteristic(this.platform.Characteristic.On, on);
          });
        }

        const brightness_characteristic = characteristics.find(chr => chr.uuid === brightness_characteristic_uuid);
        if (brightness_characteristic) {
          brightness_characteristic.subscribe();
          this.platform.log.info('Subscribed to peripheral "brightness" characterisitic', peripheral.id)
          brightness_characteristic.on('data', buff => {
            const brightness = buff.readInt8();
            this.brightness = brightness;
            this.platform.log.debug('received brightness update', this.peripheral.id, brightness);
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
          });
        }


      });

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
  }

  updateState(on: boolean, brightness: number) {
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
  }

  async setOn(value: CharacteristicValue) {
    if (this.set_on_characteristic) {
      const buff = Buffer.alloc(1);
      buff.writeInt8(value as number, 0);
      await this.set_on_characteristic.writeAsync(buff, false);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.on;
  }

  async setBrightness(value: CharacteristicValue) {
    if (this.set_brightness_characteristic) {
      const buff = Buffer.alloc(1);
      buff.writeInt8(value as number, 0);
      await this.set_brightness_characteristic.writeAsync(buff, false);
    }
  }

  async getBrightness(): Promise<CharacteristicValue> {
    return this.brightness;
  }

}

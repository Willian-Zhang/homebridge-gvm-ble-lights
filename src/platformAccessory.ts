import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { BleLights } from './platform.js';
import { Characteristic, Peripheral, ServicesAndCharacteristics } from '@abandonware/noble';
import {CRCBuffer, onoff, start_with, brightness, temprature, infoAll} from './bufferHelper.js'


export class GVMBleLightAccessory {
  private service: Service;

  private on: boolean = false;
  private brightness: number = 100;
  private temprature: number = 32;
  // 312 - 178 mired

  private char: Characteristic | undefined;

  constructor(
    private readonly platform: BleLights,
    private readonly accessory: PlatformAccessory,
    private readonly peripheral: Peripheral,
  ) {

    const char_uuid = '000102030405060708090a0b0c0d2b10';

    peripheral.connectAsync()
      .then(() => this.platform.log.info('Peripheral connected', peripheral.id))
      .then(() => peripheral.discoverSomeServicesAndCharacteristicsAsync([], [char_uuid]))
      .then(({ characteristics }: ServicesAndCharacteristics) => {
        this.platform.log.info('Configuring discovered characteristics', peripheral.id);
        this.char = characteristics.find(chr => chr.uuid === char_uuid);


        if (this.char) {
          this.char.subscribe();
          this.platform.log.info('Subscribed to peripheral "on" characterisitic', peripheral.id);
          this.char.on('data', (data, isNotification) => {
            if (isNotification) {
              this.onNotification(data);
            }
          });
          this.char.notifyAsync(true);

          this.sendBuffer(infoAll());
        }

      });

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    // this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.sendValue.bind(this, onoff))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.sendValue.bind(this, brightness))
      .onGet(this.getBrightness.bind(this));
    
    this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onSet(this.sendTemprature.bind(this))
      .onGet(this.getTemprature.bind(this));
  }

  onStateChange(cmd: Buffer) {
    const state_key = cmd.readInt8(2);
    const value = cmd.readInt8(3)
    switch (state_key) {
      case 0x00:
        // onoff
        this.platform.log.info('< onoff', value);
        this.on = value === 1;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.on);
        break;
      case 0x02:
        // brightness
        this.platform.log.info('< brightness', value);
        this.brightness = value;
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
        break;
      case 0x03:
        // temprature
        this.platform.log.info('< temprature', value);
        this.temprature = value ;
        this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, 10_000 / this.temprature);
        break;
      default:
        this.platform.log.error('can\'t recognize state_key', state_key);
        break;
    }
  }

  onStateChangeAll(cmd: Buffer) {
    const onoff = cmd.readInt8(1);
    const idonknowwhat = cmd.readInt8(2);
    const brightness = cmd.readInt8(3);
    const temprature = cmd.readInt8(4);
    this.platform.log.debug('<< onoff', onoff, 'brightness', brightness, 'temprature', temprature, 'idonknowwhat', idonknowwhat);
    this.on = onoff === 1;
    this.brightness = brightness;
    this.temprature = temprature;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.on);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, 10_000 / this.temprature);
  }

  onNotification(data: Buffer) {
    let start = 0;
    const buffer = Buffer.from(data);
    while (start < buffer.length) {
      if (!start_with(buffer, Buffer.from([0x4C, 0x54]))) {
        this.platform.log.error('header error, buffer', buffer);
      }
      start += 2;
      const len = buffer.readInt8(start);
      if (start + len > buffer.length) {
        this.platform.log.error(`len error, reading ${len} bytes, rests`, buffer.slice(start));
        return;
      }
      start += 1;
      let cmd = buffer.subarray(start, start + len);
      const crc = CRCBuffer(buffer.subarray(start - 3, start + len - 2));
      if (crc.compare(cmd.subarray(len - 2)) != 0) {
        this.platform.log.error(`crc error, crc-cmd, ${cmd.subarray(len - 2).toString()}, crc, ${crc}`);
        return;
      }
      cmd = cmd.subarray(0, len - 2);

      if (!start_with(cmd, Buffer.from([0x00, 0x20]))) {
        this.platform.log.error('can\'t recognize cmd', cmd);
      }
      cmd = cmd.subarray(2);
      const state_cat = cmd.readInt8(0);
      switch (state_cat) {
        case 0x02:
          this.onStateChange(cmd);
          break;
        case 0x03:
          // report all states
          this.onStateChangeAll(cmd);
          break;
        default:
          this.platform.log.info('can\'t recognize state_cat', state_cat, cmd);
          break;
      }
      start += len;
    }
  }

  async sendBuffer(buffer: Buffer){
    this.platform.log.debug('Setting charasterictic with buffer', buffer);
    if (this.char) {
      return await this.char.writeAsync(buffer, true);
    }
  }
  async sendValue(buffer_func: (value: number) => Buffer, value: CharacteristicValue){
    let buff = buffer_func(value as number);
    return await this.sendBuffer(buff);
  }
  async sendTemprature(value: CharacteristicValue){
    let buff = temprature(10_000 / (value as number));
    return await this.sendBuffer(buff);
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.on;
  }
  async getBrightness(): Promise<CharacteristicValue> {
    return this.brightness;
  }
  async getTemprature(): Promise<CharacteristicValue> {
    return 10_000 / this.temprature;
  }
}

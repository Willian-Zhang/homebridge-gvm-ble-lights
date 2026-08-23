import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { BleLights } from './platform.js';
import { Characteristic, Peripheral } from '@abandonware/noble';
import { CRCBuffer, onoff, start_with, brightness, temprature, infoAll } from './bufferHelper.js';
import { errorMessage, seconds, withTimeout } from './util.js';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected';

/** connect attempts per discovery, afterwards we wait for the light to show up again */
const CONNECT_ATTEMPTS = 3;
/** the light reports its state roughly every 5s, so ask for it when it went quiet for this long */
const PROBE_AFTER = 20_000;
/** ... and treat the link as dead when even the probe stays unanswered */
const DEAD_AFTER = 60_000;

export class GVMBleLightAccessory {
  private service: Service;

  private on: boolean = false;
  private brightness: number = 100;

  /**
   * raw value from BLE device, range should be: 32 - 56
   * projected value range for mired: 312 - 178
   */
  private temprature: number = 32;

  private peripheral: Peripheral | undefined;
  private char: Characteristic | undefined;
  private static char_uuid = '000102030405060708090a0b0c0d2b10';

  private connectionStatus: ConnectionStatus = 'idle';
  private statusSince = Date.now();
  /** timestamp of the last packet received from the light */
  private lastSeen = 0;
  /** all BLE operations of one device are serialized through this chain */
  private queue: Promise<unknown> = Promise.resolve();
  private recovering = false;

  constructor(
    private readonly platform: BleLights,
    private readonly accessory: PlatformAccessory,
  ) {
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // device metadata lives on the AccessoryInformation service, setting it on
    // the Lightbulb service silently did nothing
    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.updateCharacteristic(this.platform.Characteristic.Manufacturer, 'GVM')
      .updateCharacteristic(this.platform.Characteristic.Model, 'BLE Light')
      .updateCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceId)
      .updateCharacteristic(this.platform.Characteristic.FirmwareRevision, process.env.npm_package_version ?? '0.0.0');

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .removeOnGet()
      .removeOnSet()
      .onSet(this.sendOnOff.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .removeOnGet()
      .removeOnSet()
      .onSet(this.sendBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .removeOnGet()
      .removeOnSet()
      .onSet(this.sendTemprature.bind(this))
      .onGet(this.getTemprature.bind(this))
      // TODO: maybe loose it a bit, 3100K was casted from
      .setProps({
        minValue: 140,
        maxValue: 400,
      });
  }

  get deviceId(): string {
    return this.peripheral?.id ?? (this.accessory.context.id as string | undefined) ?? this.accessory.displayName;
  }

  get status(): ConnectionStatus {
    return this.connectionStatus;
  }

  isIdle(): boolean {
    return this.connectionStatus === 'idle';
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected' && !!this.char && this.peripheral?.state === 'connected';
  }

  /**
   * Takes over a (re)discovered peripheral. Peripherals are recycled by noble,
   * but their native handle is not, so everything that was discovered on the
   * previous incarnation has to be thrown away here.
   */
  attach(peripheral: Peripheral) {
    if (this.peripheral && this.peripheral !== peripheral) {
      this.peripheral.removeAllListeners('disconnect');
    }
    this.detachCharacteristic();
    this.peripheral = peripheral;
    this.accessory.context.id = peripheral.id;

    peripheral.removeAllListeners('disconnect');
    peripheral.once('disconnect', (reason: string) => this.onDisconnected(reason));

    this.setStatus('connecting');
  }

  /**
   * Must be called for the device to work
   */
  async connect(): Promise<void> {
    const peripheral = this.peripheral;
    if (!peripheral) {
      this.platform.log.debug('Nothing to connect to yet');
      return;
    }
    return this.enqueue(async () => {
      if (this.isConnected()) {
        this.platform.log.debug('Already connected to', this.deviceId);
        return;
      }
      this.setStatus('connecting');
      for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
        try {
          await this.open(peripheral);
          this.setStatus('connected');
          this.platform.log.success(`Connected to ${this.deviceId}`);
          return;
        } catch (err) {
          this.platform.log.warn(`Connecting to ${this.deviceId} failed (${attempt}/${CONNECT_ATTEMPTS}): ${errorMessage(err)}`);
          await this.abort(peripheral);
        }
      }
      this.setStatus('idle');
      this.platform.log.error(`Could not connect to ${this.deviceId}, retrying once it advertises again`);
    });
  }

  private async open(peripheral: Peripheral) {
    const timeout = this.platform.timeout;

    if (peripheral.state !== 'connected') {
      this.platform.log.debug('Connecting to', this.deviceId);
      await withTimeout(peripheral.connectAsync(), timeout, `connect ${this.deviceId}`);
    }
    this.platform.log.debug('Discovering characteristics of', this.deviceId);
    const { characteristics } = await withTimeout(
      peripheral.discoverSomeServicesAndCharacteristicsAsync([], [GVMBleLightAccessory.char_uuid]),
      timeout,
      `discoverCharacteristics ${this.deviceId}`,
    );

    const char = characteristics.find(chr => chr.uuid === GVMBleLightAccessory.char_uuid);
    if (!char) {
      throw new Error(`characteristic ${GVMBleLightAccessory.char_uuid} not found`);
    }

    this.platform.log.info('Configuring discovered characteristics', this.deviceId);
    char.removeAllListeners('data');
    char.on('data', (data, isNotification) => {
      this.lastSeen = Date.now();
      if (isNotification) {
        this.onNotification(data);
      }
    });
    await withTimeout(char.subscribeAsync(), timeout, `subscribe ${this.deviceId}`);
    await withTimeout(char.notifyAsync(true), timeout, `notify ${this.deviceId}`);
    this.platform.log.info('Subscribed to peripheral characterisitics', this.deviceId);

    this.char = char;
    this.lastSeen = Date.now();
    await this.write(infoAll());
  }

  /** cleans up after a failed connect so the next attempt starts from scratch */
  private async abort(peripheral: Peripheral) {
    this.detachCharacteristic();
    try {
      // settles the connect promise noble would otherwise leak
      peripheral.cancelConnect();
      if (peripheral.state !== 'disconnected') {
        await withTimeout(peripheral.disconnectAsync(), this.platform.timeout, `disconnect ${this.deviceId}`);
      }
    } catch (err) {
      this.platform.log.debug('Cleanup after failed connect:', errorMessage(err));
    }
  }

  private onDisconnected(reason?: string) {
    this.platform.log.info('Peripherial disconnected:', this.deviceId);
    this.platform.log.debug('Reason:', reason);
    this.detachCharacteristic();
    this.setStatus('idle');
    // being discovered again is what triggers the reconnect
    void this.platform.startScanning();
  }

  /**
   * Drops every BLE handle without touching the adapter. Used when the adapter
   * itself went away (reset / powered off): its handles are invalid and any
   * call would simply never be answered.
   */
  invalidate(reason: string) {
    if (this.isIdle() && !this.char && !this.peripheral) {
      return;
    }
    this.platform.log.debug(`Dropping BLE handles of ${this.deviceId}: ${reason}`);
    this.peripheral?.removeAllListeners('disconnect');
    this.detachCharacteristic();
    this.peripheral = undefined;
    this.setStatus('idle');
  }

  /**
   * @returns whether the device is healthy, `false` asks the platform to scan for it
   */
  healthCheck(): boolean {
    const since = Date.now() - this.statusSince;
    switch (this.connectionStatus) {
      case 'idle':
        return false;
      case 'connecting':
        // every BLE call is bounded, so connecting cannot take forever anymore.
        // if it still does, force a fresh start instead of waiting forever.
        if (since > this.connectTimeBudget) {
          this.platform.log.warn(`${this.deviceId} has been connecting for ${seconds(since)}, starting over`);
          void this.recover('stuck while connecting');
          return false;
        }
        return true;
      case 'connected': {
        if (!this.isConnected()) {
          this.platform.log.warn(`${this.deviceId} is not connected anymore (${this.peripheral?.state})`);
          void this.recover('connection lost');
          return false;
        }
        const silence = Date.now() - this.lastSeen;
        if (silence > DEAD_AFTER) {
          this.platform.log.warn(`No answer from ${this.deviceId} for ${seconds(silence)}, reconnecting`);
          void this.recover('no answer');
          return false;
        }
        if (silence > PROBE_AFTER) {
          this.platform.log.debug(`Quiet for ${seconds(silence)}, probing ${this.deviceId}`);
          this.sendBuffer(infoAll()).catch((err) => this.platform.log.debug('Probe failed:', errorMessage(err)));
        }
        return true;
      }
    }
  }

  /** worst case duration of `connect()`, only used to detect a wedged connect */
  private get connectTimeBudget(): number {
    return CONNECT_ATTEMPTS * 6 * this.platform.timeout;
  }

  private async recover(reason: string) {
    if (this.recovering) {
      return;
    }
    this.recovering = true;
    try {
      this.platform.log.info(`Recovering ${this.deviceId}: ${reason}`);
      const peripheral = this.peripheral;
      this.detachCharacteristic();
      this.setStatus('idle');
      if (peripheral) {
        await this.abort(peripheral);
      }
      await this.platform.startScanning();
    } finally {
      this.recovering = false;
    }
  }

  async disconnect() {
    this.platform.log.debug('disconnect', this.deviceId);
    const peripheral = this.peripheral;
    const char = this.char;
    const timeout = this.platform.timeout;
    this.detachCharacteristic();
    this.setStatus('idle');

    if (char) {
      await withTimeout(char.unsubscribeAsync(), timeout, `unsubscribe ${this.deviceId}`)
        .catch((err) => this.platform.log.debug('Failed to unsubscribe:', errorMessage(err)));
    }
    if (peripheral) {
      peripheral.removeAllListeners('disconnect');
      if (peripheral.state !== 'disconnected') {
        await withTimeout(peripheral.disconnectAsync(), timeout, `disconnect ${this.deviceId}`)
          .catch((err) => this.platform.log.debug('Failed to disconnect:', errorMessage(err)));
      }
    }
  }

  private detachCharacteristic() {
    if (this.char) {
      // a leftover characteristic keeps pushing data into a dead connection
      this.char.removeAllListeners('data');
      this.char = undefined;
    }
  }

  private setStatus(status: ConnectionStatus) {
    if (this.connectionStatus !== status) {
      this.platform.log.debug(`${this.deviceId}: ${this.connectionStatus} -> ${status}`);
    }
    this.connectionStatus = status;
    this.statusSince = Date.now();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
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
        this.platform.log.info('< temprature', value, `(${10_000/value})`);
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

  /** raw write, only to be called from inside the operation queue */
  private async write(buffer: Buffer) {
    const { char, peripheral } = this;
    if (!char || !peripheral) {
      throw new Error(`${this.deviceId} is not connected`);
    }
    if (peripheral.state !== 'connected') {
      throw new Error(`${this.deviceId} is ${peripheral.state}`);
    }
    this.platform.log.debug('Setting charasterictic with buffer', buffer);
    await withTimeout(char.writeAsync(buffer, true), this.platform.timeout, `write ${this.deviceId}`);
  }

  async sendBuffer(buffer: Buffer){
    try {
      await this.enqueue(() => this.write(buffer));
    } catch (err) {
      this.platform.log.error(`Failed to send command to ${this.deviceId}: ${errorMessage(err)}`);
      void this.recover('sending a command failed');
      // let HomeKit show "No Response" instead of pretending the command arrived
      throw this.communicationFailure();
    }
  }

  async sendValue(buffer_func: (value: number) => Buffer, value: CharacteristicValue){
    const buff = buffer_func(value as number);
    return await this.sendBuffer(buff);
  }

  async sendOnOff(value: CharacteristicValue){
    const buff = onoff(value as number);
    this.platform.log.info('> onoff', value);
    return await this.sendBuffer(buff);
  }

  async sendBrightness(value: CharacteristicValue){
    const buff = brightness(value as number);
    this.platform.log.info('> brightness', value);
    return await this.sendBuffer(buff);
  }

  async sendTemprature(value: CharacteristicValue){
    let temp = value as number;
    // mirad range
    temp = 10_000 / temp
    // raw range
    temp = Math.max(temp, 32);
    temp = Math.min(temp, 56);
    temp = Math.round(temp);
    this.platform.log.info('> temprature', temp, `(${10_000/temp})`);
    const buff = temprature(temp);
    return await this.sendBuffer(buff);
  }

  async getOn(): Promise<CharacteristicValue> {
    this.assertConnected();
    return this.on;
  }

  async getBrightness(): Promise<CharacteristicValue> {
    this.assertConnected();
    return this.brightness;
  }

  async getTemprature(): Promise<CharacteristicValue> {
    this.assertConnected();
    return 10_000 / this.temprature;
  }

  private assertConnected() {
    if (!this.isConnected()) {
      throw this.communicationFailure();
    }
  }

  private communicationFailure() {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}

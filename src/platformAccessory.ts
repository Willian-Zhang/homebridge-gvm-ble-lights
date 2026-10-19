import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { BleLights } from './platform.js';
import { Characteristic, DisconnectReason, Peripheral } from '@stoprocent/noble';
import { CRCBuffer, onoff, start_with, brightness, temprature, infoAll, parseStatus, heartbeatReply, Register } from './bufferHelper.js';
import { delay, errorMessage, seconds, withTimeout } from './util.js';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected';

/** every frame starts with "LT" */
const FRAME_HEADER = Buffer.from([0x4C, 0x54]);
/** the header, then one byte for the length of the rest of the frame */
const FRAME_PREFIX = FRAME_HEADER.length + 1;
/** every frame ends with a CRC16 over everything before it */
const CRC_LENGTH = 2;

/** connect attempts per discovery, afterwards we wait for the light to show up again */
const CONNECT_ATTEMPTS = 3;
/** the light reports its state roughly every 5s, so probe it when it went quiet for this long */
const PROBE_AFTER = 20_000;
/** ... and treat the link as dead when even the probe stays unanswered */
const DEAD_AFTER = 60_000;
/** HomeKit writes the characteristics of a scene separately, collect them for this long before talking to the light */
const COMMIT_DEBOUNCE = 80;
/** the light restores its own output while powering on, so wait before overriding it */
const POWER_ON_SETTLE = 250;
/** commands are written without a response, pace them instead of flooding a single connection interval */
const WRITE_GAP = 50;

/** what HomeKit asked for but what has not been written to the light yet */
type DesiredState = {
  on?: boolean;
  brightness?: number;
  /** raw device value, 32 - 56 */
  temprature?: number;
};

/** one BLE command plus the time the light needs before the next one may follow */
type Step = {
  buffer: Buffer;
  settle?: number;
};

export class GVMBleLightAccessory {
  private service: Service;

  private on: boolean = false;
  private brightness: number = 100;

  /**
   * raw value from BLE device, range should be: 32 - 56
   * projected value range for mired: 312 - 178
   */
  private temprature: number = 32;

  /** channel selected on the light, kept across reconnects since changing it drops the link */
  private channel?: number;

  private peripheral: Peripheral | undefined;
  private char: Characteristic | undefined;
  private static char_uuid = '000102030405060708090a0b0c0d2b10';

  private connectionStatus: ConnectionStatus = 'idle';
  private statusSince = Date.now();
  /** timestamp of the last packet received from the light */
  private lastSeen = 0;
  /** all BLE operations of one device are serialized through this chain */
  private queue: Promise<unknown> = Promise.resolve();
  /** operations in the queue that have not finished yet */
  private queued = 0;
  private recovering = false;

  private desired: DesiredState = {};
  /** the values of the commit that is currently on the wire */
  private inflight: DesiredState = {};
  private commitTimer?: NodeJS.Timeout;
  /** shared by every HomeKit write that ends up in the same commit */
  private commit?: { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };

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
    peripheral.once('disconnect', (reason: DisconnectReason) => this.onDisconnected(reason));

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
    this.platform.log.debug('Characteristic properties:', char.properties.join(', '));
    char.removeAllListeners('data');
    char.on('data', (data, isNotification) => {
      this.lastSeen = Date.now();
      if (isNotification) {
        this.onNotification(data);
      }
    });
    await withTimeout(char.subscribeAsync(), timeout, `subscribe ${this.deviceId}`);
    this.platform.log.info('Subscribed to peripheral characterisitics', this.deviceId);

    this.char = char;
    this.lastSeen = Date.now();
    await this.write(infoAll());
  }

  /** cleans up after a failed connect so the next attempt starts from scratch */
  private async abort(peripheral: Peripheral) {
    this.detachCharacteristic();
    try {
      // settles the connect promise noble would otherwise leak and cancels a
      // still pending OS connection. Only does something while `connecting`,
      // and a binding that throws here must not prevent the disconnect below.
      peripheral.cancelConnect();
    } catch (err) {
      this.platform.log.debug('cancelConnect failed:', errorMessage(err));
    }
    try {
      // CoreBluetooth never times out a pending connect on its own. Unless it
      // is cancelled here it completes later behind our back, and a connected
      // light stops advertising - so it would never be discovered again.
      // `cancelConnect()` marks a pending connect `disconnected` right away,
      // so this covers a connect that completed or failed.
      if (peripheral.state !== 'disconnected') {
        await withTimeout(peripheral.disconnectAsync(), this.platform.timeout, `disconnect ${this.deviceId}`);
      }
    } catch (err) {
      this.platform.log.debug('Cleanup after failed connect:', errorMessage(err));
    }
  }

  private onDisconnected(reason?: DisconnectReason) {
    this.platform.log.info('Peripherial disconnected:', this.deviceId);
    this.platform.log.debug('Reason:', reason);
    this.detachCharacteristic();
    this.setStatus('idle');
    // being discovered again is what triggers the reconnect. Deferred because
    // noble emits `disconnect` for every peripheral *before* it reports the
    // adapter leaving `poweredOn`: scanning right away would hit an adapter
    // that is going down, and its `scanStart` would leave `scanning` set for
    // a scan that never runs once the adapter is back.
    setImmediate(() => void this.platform.startScanning());
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
      case 'idle': {
        // an idle handler must not hold an OS-level connection: the light stops
        // advertising while connected, so rediscovery could never happen
        const state = this.peripheral?.state;
        if (state === 'connected' || state === 'connecting') {
          this.platform.log.warn(`${this.deviceId} is idle but still ${state} at the OS level, dropping the connection`);
          void this.recover(`stale ${state} peripheral`);
        }
        return false;
      }
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
    this.queued++;
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined).finally(() => this.queued--);
    return run;
  }

  onStateChange(cmd: Buffer) {
    if (cmd.length < 4) {
      this.platform.log.error('state change too short', cmd.toString('hex'));
      return;
    }
    const state_key = cmd.readUInt8(2);
    const value = cmd.readUInt8(3);
    switch (state_key) {
      case Register.ON:
        this.platform.log.info('< onoff', value);
        this.reportOn(value === 1);
        break;
      case Register.CHANNEL:
        this.reportChannel(value);
        break;
      case Register.BRIGHTNESS:
        this.platform.log.info('< brightness', value);
        this.reportBrightness(value);
        break;
      case Register.TEMPRATURE:
        this.platform.log.info('< temprature', value, `(${10_000/value})`);
        this.reportTemprature(value);
        break;
      default:
        this.platform.log.error('can\'t recognize state_key', state_key);
        break;
    }
  }

  onStateChangeAll(cmd: Buffer) {
    const status = parseStatus(cmd);
    if (!status) {
      this.platform.log.error('status report too short', cmd.toString('hex'));
      return;
    }
    const { on, channel, brightness, temprature } = status;
    this.platform.log.debug('<< onoff', on ? 1 : 0, 'brightness', brightness, 'temprature', temprature, 'channel', channel);
    if (cmd.length > 1 + Register.TEMPRATURE + 1) {
      this.platform.log.debug('<< unparsed state bytes', cmd.subarray(1 + Register.TEMPRATURE + 1).toString('hex'));
    }
    this.reportChannel(channel);
    this.reportOn(on);
    this.reportBrightness(brightness);
    this.reportTemprature(temprature);
    this.answerStatusReport(cmd);
  }

  /**
   * Echoes a status report like the GVM app does, see `heartbeatReply()`. The
   * echo carries the values of the report, so it is skipped while a command is
   * queued or on the wire: sent after that command it would hold values the
   * light no longer has. Answering is best effort, a failing link is detected
   * by the commands and the watchdog.
   */
  private answerStatusReport(report: Buffer) {
    if (!this.isConnected() || this.queued > 0) {
      return;
    }
    const reply = heartbeatReply(report);
    this.enqueue(async () => {
      await this.write(reply);
      // a command right behind the reply would arrive while the light is still busy
      await delay(WRITE_GAP);
    }).catch((err) => this.platform.log.debug('Answering the status report failed:', errorMessage(err)));
  }

  /**
   * The answer to `infoAll()`: `53 00 <register> <count> <values>`, so far only
   * seen as `53 00 00 02 20 38`, presumably the color temperature range.
   */
  onInfoReply(cmd: Buffer) {
    const values = cmd.subarray(4);
    if (cmd.length < 4 || values.length !== cmd.readUInt8(3)) {
      this.platform.log.debug('<< unexpected info reply', cmd.toString('hex'));
      return;
    }
    if (values.length === 2) {
      this.platform.log.debug(`<< ${this.deviceId}: color temperature range ${values[0] * 100}K - ${values[1] * 100}K`);
    } else {
      this.platform.log.debug('<< info reply', values.toString('hex'));
    }
  }

  /**
   * HomeKit has no characteristic for the channel, so it only goes to the log.
   * The light may come back with a different brightness and color temperature
   * after a channel change, this explains why.
   */
  private reportChannel(channel: number) {
    if (channel === this.channel) {
      return;
    }
    if (this.channel === undefined) {
      this.platform.log.info(`${this.deviceId}: on channel ${channel}`);
    } else {
      this.platform.log.info(`${this.deviceId}: channel changed from ${this.channel} to ${channel}`);
    }
    this.channel = channel;
  }

  /**
   * Reports from the light are only authoritative for the values we are not
   * about to write ourselves: the light keeps reporting its old state until our
   * commit went out, which would otherwise undo the user's input in HomeKit
   * right after they made it.
   */
  private isPending(key: keyof DesiredState): boolean {
    return this.desired[key] !== undefined || this.inflight[key] !== undefined;
  }

  private reportOn(on: boolean) {
    if (this.isPending('on')) {
      return;
    }
    this.on = on;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.on);
  }

  private reportBrightness(brightness: number) {
    if (this.isPending('brightness')) {
      return;
    }
    this.brightness = brightness;
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
  }

  private reportTemprature(temprature: number) {
    if (this.isPending('temprature')) {
      return;
    }
    this.temprature = temprature;
    this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, 10_000 / this.temprature);
  }

  onNotification(data: Buffer) {
    let start = 0;
    const buffer = Buffer.from(data);
    // a notification may hold several frames: "LT" <len> <len bytes, the last two a CRC>
    while (start < buffer.length) {
      const rest = buffer.subarray(start);
      if (!start_with(rest, FRAME_HEADER)) {
        // without a valid header the frame boundaries are lost, drop the rest
        this.platform.log.error('header error, rests', rest.toString('hex'));
        return;
      }
      const len = rest.length > FRAME_HEADER.length ? rest.readUInt8(FRAME_HEADER.length) : 0;
      if (len < CRC_LENGTH || FRAME_PREFIX + len > rest.length) {
        this.platform.log.error(`len error, reading ${len} bytes, rests`, rest.toString('hex'));
        return;
      }
      start += FRAME_PREFIX + len;

      const frame = rest.subarray(0, FRAME_PREFIX + len);
      const received = frame.subarray(frame.length - CRC_LENGTH);
      const crc = CRCBuffer(frame.subarray(0, frame.length - CRC_LENGTH));
      if (crc.compare(received) != 0) {
        this.platform.log.error(`crc error, frame ${frame.toString('hex')}, expected crc ${crc.toString('hex')}`);
        return;
      }

      let cmd = frame.subarray(FRAME_PREFIX, frame.length - CRC_LENGTH);
      if (!start_with(cmd, Buffer.from([0x00, 0x20])) || cmd.length < 3) {
        this.platform.log.error('can\'t recognize cmd', cmd.toString('hex'));
        continue;
      }
      cmd = cmd.subarray(2);
      const state_cat = cmd.readUInt8(0);
      switch (state_cat) {
        case 0x02:
          this.onStateChange(cmd);
          break;
        case 0x03:
          // report all states
          this.onStateChangeAll(cmd);
          break;
        case 0x53:
          this.onInfoReply(cmd);
          break;
        default:
          this.platform.log.info('can\'t recognize state_cat', state_cat, cmd.toString('hex'));
          break;
      }
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
    return await this.sendSteps([{ buffer }]);
  }

  private async sendSteps(steps: Step[]): Promise<void> {
    try {
      await this.enqueue(async () => {
        for (const [index, step] of steps.entries()) {
          if (index > 0) {
            // the light drops commands that arrive while it is still busy with
            // the previous one, and they are written without a response, so
            // there is nothing that would tell us to slow down
            await delay(steps[index - 1].settle ?? WRITE_GAP);
          }
          await this.write(step.buffer);
        }
      });
    } catch (err) {
      this.platform.log.error(`Failed to send command to ${this.deviceId}: ${errorMessage(err)}`);
      void this.recover('sending a command failed');
      // let HomeKit show "No Response" instead of pretending the command arrived
      throw this.communicationFailure();
    }
  }

  /**
   * HomeKit writes the characteristics of one scene as separate, concurrent
   * requests and it deliberately writes `On` last, assuming an accessory
   * remembers what it received while it was off. GVM lights don't: they
   * acknowledge the value but restore their own latched output when they power
   * on, so brightness and color temperature written before the `On` are lost.
   *
   * That is why the writes are collected here instead of being forwarded one by
   * one, and committed in an order the light actually honours.
   */
  private request(patch: DesiredState): Promise<void> {
    Object.assign(this.desired, patch);

    if (!this.commit) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.commit = { promise, resolve, reject };
    }
    const commit = this.commit;

    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
    }
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      this.commit = undefined;
      this.flush().then(commit.resolve, commit.reject);
    }, COMMIT_DEBOUNCE);
    // deliberately not unref'd: this timer holds a write the user is waiting for

    return commit.promise;
  }

  private async flush(): Promise<void> {
    const wanted = this.desired;
    const { on: wantOn, brightness: wantBrightness, temprature: wantTemprature } = wanted;
    this.desired = {};
    this.inflight = wanted;

    const steps: Step[] = [];
    if (wantOn === false) {
      // writing brightness/temprature to a light that is off has no effect, the
      // values are re-asserted the next time it is switched on
      steps.push({ buffer: onoff(0) });
    } else {
      if (wantOn === true) {
        steps.push({ buffer: onoff(1), settle: POWER_ON_SETTLE });
      }
      // powering on always re-asserts both values, otherwise the light comes
      // back up with whatever it was showing before it was switched off
      if (wantOn === true || wantTemprature !== undefined) {
        steps.push({ buffer: temprature(wantTemprature ?? this.temprature) });
      }
      if (wantOn === true || wantBrightness !== undefined) {
        steps.push({ buffer: brightness(wantBrightness ?? this.brightness) });
      }
    }

    try {
      if (!steps.length) {
        return;
      }
      this.platform.log.debug(`Committing ${steps.length} command(s) to ${this.deviceId}`);
      await this.sendSteps(steps);
      // the light does echo what it accepted, but relying on that echo alone
      // leaves the cache - and with it the re-assert of the next power-on - on
      // the old value whenever a report goes missing
      if (wantOn !== undefined) {
        this.on = wantOn;
      }
      if (wantBrightness !== undefined) {
        this.brightness = wantBrightness;
      }
      if (wantTemprature !== undefined) {
        this.temprature = wantTemprature;
      }
    } finally {
      if (this.inflight === wanted) {
        this.inflight = {};
      }
    }
  }

  async sendValue(buffer_func: (value: number) => Buffer, value: CharacteristicValue){
    const buff = buffer_func(value as number);
    return await this.sendBuffer(buff);
  }

  async sendOnOff(value: CharacteristicValue){
    this.platform.log.info('> onoff', value);
    return await this.request({ on: value as boolean });
  }

  async sendBrightness(value: CharacteristicValue){
    this.platform.log.info('> brightness', value);
    return await this.request({ brightness: value as number });
  }

  async sendTemprature(value: CharacteristicValue){
    const temp = GVMBleLightAccessory.toRawTemprature(value as number);
    this.platform.log.info('> temprature', temp, `(${10_000/temp})`);
    return await this.request({ temprature: temp });
  }

  /** mired (HomeKit) to the raw 32 - 56 (3200K - 5600K) the light understands */
  private static toRawTemprature(mired: number): number {
    const temp = Math.round(10_000 / mired);
    return Math.min(Math.max(temp, 32), 56);
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

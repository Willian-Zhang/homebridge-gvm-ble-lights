import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import noble, { Peripheral } from '@abandonware/noble';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { GVMBleLightAccessory } from './platformAccessory.js';
import { errorMessage, withTimeout } from './util.js';

/** the (HID) service the GVM lights advertise */
const SERVICE_UUID = '1812';
/** upper bound for a single BLE operation */
const DEFAULT_TIMEOUT = 10_000;
/** how often every device is checked for being alive */
const DEFAULT_POLL_INTERVAL = 15_000;

export type BleLightsConfig = PlatformConfig & {
  devices?: { name: string; id?: string }[];
  /** how often the connection to every device is verified, in milliseconds */
  pollInterval?: number;
  /** how long a single BLE operation may take before it is considered failed, in milliseconds */
  timeout?: number;
};

export class BleLights implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  /**
   * One handler per accessory, kept for the lifetime of the plugin. Creating a
   * new handler on every rediscovery used to leak `disconnect`/`data`
   * listeners and left the previous instance (with its dead characteristic)
   * behind.
   */
  private readonly handlers: Map<string, GVMBleLightAccessory> = new Map();

  private adapterState: string = noble._state;
  private scanning = false;
  private scanRequest?: Promise<void>;
  private healthCheckTimer?: NodeJS.Timeout;
  /** discoveries are only processed once the cached accessories are restored */
  private ready = false;
  private shuttingDown = false;

  get timeout(): number {
    return this.config.timeout ?? DEFAULT_TIMEOUT;
  }

  get pollInterval(): number {
    return this.config.pollInterval ?? DEFAULT_POLL_INTERVAL;
  }

  /** `undefined` when the user did not configure a device list: we can't know how many lights to expect */
  private get expectedDeviceCount(): number | undefined {
    return this.config.devices?.length;
  }

  private get hasConfiguredIds(): boolean {
    return !!this.config.devices?.at(0)?.id;
  }

  async startScanning(): Promise<void> {
    if (!this.ready || this.shuttingDown) {
      return;
    }
    if (this.adapterState !== 'poweredOn') {
      this.log.debug('Not scanning, adapter state is', this.adapterState);
      return;
    }
    if (this.scanning) {
      this.log.debug('Already scanning');
      return;
    }
    if (this.scanRequest) {
      return this.scanRequest;
    }
    this.log.debug('Starting scanning');
    // `scanning` is only ever set from noble's own scanStart/scanStop events:
    // guessing it here is what used to leave the plugin in a state where it
    // believed it was scanning while it was not, so it never scanned again.
    this.scanRequest = withTimeout(noble.startScanningAsync([SERVICE_UUID], false), this.timeout, 'startScanning')
      .catch((err) => this.log.error('Failed to start scanning:', errorMessage(err)))
      .finally(() => {
        this.scanRequest = undefined;
      });
    return this.scanRequest;
  }

  async stopScanning(): Promise<void> {
    if (!this.scanning) {
      this.log.debug('Not scanning, nothing to stop');
      return;
    }
    this.log.debug('Stopping scanning...');
    await withTimeout(noble.stopScanningAsync(), this.timeout, 'stopScanning')
      .catch((err) => this.log.debug('Failed to stop scanning:', errorMessage(err)));
  }

  constructor(
    public readonly log: Logging,
    public readonly config: BleLightsConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // Homebridge 1.8.0 introduced a `log.success` method that can be used to log success messages
    // For users that are on a version prior to 1.8.0, we need a 'polyfill' for this method
    if (!log.success) {
      log.success = log.info;
    }

    noble.on('stateChange', (state: string) => {
      this.onAdapterStateChange(state).catch((err) => this.log.error('Failed to handle adapter state:', errorMessage(err)));
    });
    noble.on('scanStart', () => {
      this.scanning = true;
      this.log.debug('Scan started');
    });
    noble.on('scanStop', () => {
      this.scanning = false;
      this.log.debug('Scan stopped');
    });
    noble.on('discover', (peripheral: Peripheral) => {
      this.onDiscover(peripheral).catch((err) => this.log.error('Failed to handle discovered peripheral:', errorMessage(err)));
    });
    noble.on('warning', (message: string) => this.log.debug('BLE warning:', message));

    this.log.debug('Finished initializing platform.');

    this.api.on('didFinishLaunching', () => {
      this.log.info('finished launching');
      this.ready = true;
      void this.startScanning();
      // watchdog: nothing else notices a connection that died silently
      this.healthCheckTimer = setInterval(() => this.healthCheck(), this.pollInterval);
      this.healthCheckTimer.unref();
    });

    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  private async onAdapterStateChange(state: string) {
    this.adapterState = state;
    this.log.debug('Noble state changed to:', state);
    if (state === 'poweredOn') {
      await this.startScanning();
    } else if (state === 'unauthorized') {
      this.log.error('BLE device not authorized, try add this app to the whitelist');
    } else {
      // resetting / poweredOff / unsupported: every handle we are holding is
      // dead now. Talking to them (not even to disconnect them) is pointless -
      // CoreBluetooth simply drops the request and never answers, which is
      // exactly how the plugin used to get stuck in `connect` forever.
      // Just forget them and wait for the devices to be discovered again.
      this.scanning = false;
      this.log.info(`BLE ${state}, dropping all connections and waiting for it to be poweredOn again...`);
      for (const handler of this.handlers.values()) {
        handler.invalidate(`adapter is ${state}`);
      }
    }
  }

  private async onDiscover(peripheral: Peripheral) {
    if (!this.ready || this.shuttingDown) {
      return;
    }
    const { id } = peripheral;
    if (!this.hasConfiguredIds && peripheral.advertisement.localName !== 'BT_LED') {
      this.log.debug('Ignoring peripheral', id, peripheral.advertisement.localName);
      return;
    }

    const uuid = this.api.hap.uuid.generate(id);
    let handler = this.handlers.get(uuid);
    if (handler && !handler.isIdle()) {
      this.log.debug('Ignoring already claimed peripheral', id, `(${handler.status})`);
      return;
    }
    if (!peripheral.connectable) {
      this.log.info('peripheral not connectable:', id);
      return;
    }

    this.log.info('Discovered peripherial', id);
    if (!handler) {
      const match_config = this.config.devices?.find((d) => d.id === id);
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      if (existingAccessory) {
        this.log.info('Register existing accessory:', id);
        handler = new GVMBleLightAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', id);
        const accessory = new this.api.platformAccessory(match_config?.name ?? 'GVM Light', uuid);
        handler = new GVMBleLightAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
      this.handlers.set(uuid, handler);
    } else {
      this.log.info('Reconnecting to known accessory:', id);
    }

    // claims the peripheral, so a second advertisement doesn't start a second connect
    handler.attach(peripheral);

    if (this.allDevicesClaimed()) {
      await this.stopScanning();
    } else {
      this.log.debug('Still waiting for devices, keep scanning');
    }

    await handler.connect();
  }

  private allDevicesClaimed(): boolean {
    const expected = this.expectedDeviceCount;
    if (expected === undefined) {
      return false;
    }
    let claimed = 0;
    for (const handler of this.handlers.values()) {
      if (!handler.isIdle()) {
        claimed++;
      }
    }
    return claimed >= expected;
  }

  /**
   * Rediscovery is what drives reconnection, so anything that is not connected
   * has to get us back into scanning - a failed/hung connect, a disconnect
   * event that never arrived, or an adapter that came back from a reset.
   */
  private healthCheck() {
    if (this.shuttingDown) {
      return;
    }
    if (this.adapterState !== 'poweredOn') {
      this.log.debug('Skipping health check, adapter state is', this.adapterState);
      return;
    }
    let needsScanning = !this.allDevicesClaimed();
    for (const handler of this.handlers.values()) {
      if (!handler.healthCheck()) {
        needsScanning = true;
      }
    }
    if (needsScanning) {
      this.log.debug('Not every device is connected, making sure we are scanning');
      void this.startScanning();
    }
  }

  private async shutdown() {
    this.shuttingDown = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    await this.stopScanning();
    await Promise.all(Array.from(this.handlers.values(), (handler) => handler.disconnect()));
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

}

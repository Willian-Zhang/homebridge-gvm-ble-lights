import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { HttpLightAccessory, HttpLightAccessoryConfig } from './platformAccessory.js';

export class HttpLights implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig & {
      devices?: { name: string; ip: string; enabled: boolean }[]; pollInterval?: number; timeout?: number;
    },
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    // Homebridge 1.8.0 introduced a `log.success` method that can be used to log success messages
    // For users that are on a version prior to 1.8.0, we need a 'polyfill' for this method
    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  discoverDevices() {

    const devices = (this.config.devices || []).filter(d => d.enabled);

    this.accessories.forEach(accessory => {
      const isConfigured = devices.some(device => device.name === accessory.displayName);
      if (!isConfigured) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info('Removing obsolete accessory:', accessory.displayName);
      }
    });

    for (const device of devices) {

      const deviceConfig: HttpLightAccessoryConfig = {
        url: `http://${device.ip}/`,
        timeout: this.config.timeout!,
        pollInterval: this.config.pollInterval!,
      };

      const uuid = this.api.hap.uuid.generate(device.name);
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        new HttpLightAccessory(this, existingAccessory, deviceConfig);
      } else {
        this.log.info('Adding new accessory:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        new HttpLightAccessory(this, accessory, deviceConfig);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}

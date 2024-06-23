import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import noble, { Peripheral } from '@abandonware/noble';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { BleLightAccessory } from './platformAccessory.js';

export class BleLights implements DynamicPlatformPlugin {
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

    const service_uuid = 'cad6e164de14425f8d19f241b592a385';
    noble.on('stateChange', async (state: string) => {
      if (state === 'poweredOn') {
        await noble.startScanningAsync([service_uuid], false);
      }
    });

    this.log.debug('Finished initializing platform:', this.config.name);

    // Homebridge 1.8.0 introduced a `log.success` method that can be used to log success messages
    // For users that are on a version prior to 1.8.0, we need a 'polyfill' for this method
    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      this.log.info('finished launching');
      noble.on('discover', async (peripheral: Peripheral) => {
        const { id } = peripheral;
        const uuid = this.api.hap.uuid.generate(id);
        this.log.info('Discovered peripherial', peripheral.id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (!existingAccessory) {
          this.log.info('Adding new accessory:', uuid);
          const accessory = new this.api.platformAccessory(id, uuid);
          new BleLightAccessory(this, accessory, peripheral);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }else {
          //TODO it can create duplicated instance if peripheral is discovered again - check if instance exists!
          new BleLightAccessory(this, existingAccessory, peripheral);
        }

      });
    });
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

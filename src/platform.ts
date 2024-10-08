import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import noble, { Peripheral } from '@abandonware/noble';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { GVMBleLightAccessory } from './platformAccessory.js';

export class BleLights implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private isScanning = false;
  async startScanning() {
    const service_uuid = '1812';
    if (this.isScanning) {
      this.log.debug('Already scanning');
      return;
    }
    this.log.debug('Starting scanning');
    this.isScanning = true;
    noble.on('scanStop', () => {
      this.log.debug('Scan stopped');
      this.isScanning = false;
    });
    await noble.startScanningAsync([service_uuid], false);
  }

  stopScanning() {
    this.log.debug('Stopping scanning');
    this.isScanning = false
    noble.stopScanning();
  }

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig & {
      devices?: { name: string; id?:string }[]; pollInterval?: number; timeout?: number;
    },
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    
    noble.on('stateChange', async (state: string) => {
      this.log.debug('Noble state changed to:', state);
      if (state === 'poweredOn') {
        this.startScanning();
      }
      else if (state === 'unauthorized') {
        this.log.error('BLE device not authorized, try add this app to the whitelist');
      }
    });

    this.log.debug('Finished initializing platform.');

    // Homebridge 1.8.0 introduced a `log.success` method that can be used to log success messages
    // For users that are on a version prior to 1.8.0, we need a 'polyfill' for this method
    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      this.log.info('finished launching');
      const wait_for_finding_devices = new Set();
      // let device_no_id = false;
      for (const device of this.config.devices || []) {
        if (device.id) {
          wait_for_finding_devices.add(device.id);
        } else{
          // Only one device without id is allowed
          // device_no_id = true;
          break;
        }
      }
      const found_devices = new Set();
      noble.on('discover', async (peripheral: Peripheral) => {
        if (!this.config.devices?.at(0)?.id && peripheral.advertisement.localName !== 'BT_LED') {
          this.log.debug('Ignoring peripheral', peripheral.id, peripheral.advertisement.localName);
          return;
        }
        if (found_devices.has(peripheral.id)) {
          this.log.info('Ignoring already found peripheral', peripheral.id);
          return;
        }
        this.log.info('Discovered peripherial', peripheral.id);
        const { id } = peripheral;
        let match_config = null;
        for (const device of this.config.devices || []) {
          if (device.id === id) {
            match_config = device;
            break;
          }
        }

        const uuid = this.api.hap.uuid.generate(id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        
        if (!existingAccessory) {
          this.log.info('Adding new accessory:', uuid);
          const accessory = new this.api.platformAccessory(match_config?.name ?? "GVM Light", uuid);
          new GVMBleLightAccessory(this, accessory, peripheral);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }else {
          new GVMBleLightAccessory(this, existingAccessory, peripheral);
        }
        peripheral.once('disconnect', () => {
          this.log.info('Peripheral disconnected:', id);
          found_devices.delete(id);
          wait_for_finding_devices.add(id);
          this.startScanning();
        });
        found_devices.add(id);
        wait_for_finding_devices.delete(id);
        if (wait_for_finding_devices.size === 0 && this.config.devices) {
          this.stopScanning();
        }else {
          this.log.debug('Still waiting for devices:', Array.from(wait_for_finding_devices));
        }
      });
      // TODO: reconnect
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

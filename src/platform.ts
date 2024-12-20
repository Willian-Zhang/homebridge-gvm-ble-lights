import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import noble, { Peripheral } from '@abandonware/noble';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { GVMBleLightAccessory } from './platformAccessory.js';

export class BleLights implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  private found_devices:Set<string> = new Set();
  private connected_preripherals: Set<Peripheral> = new Set();

  private isScanning = false;
  async startScanning() {
    const service_uuid = '1812';
    if (this.isScanning) {
      this.log.debug('Already scanning');
      return;
    }
    this.log.debug('Starting scanning');
    this.isScanning = true;
    noble.once('scanStop', () => {
      this.log.debug('Scan stopped');
      this.isScanning = false;
    });
    await noble.startScanningAsync([service_uuid], false);
  }

  stopScanning() {
    this.log.debug('Stopping scanning...');
    this.isScanning = false
    return noble.stopScanningAsync();
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
      }else if (state === 'resetting') {
        this.log.info('BLE resetting, waiting for it to be poweredOn again...');
        this.connected_preripherals.forEach((p) => p.disconnect())
        this.found_devices.clear();
        this.connected_preripherals.clear()
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
      noble.on('discover', async (peripheral: Peripheral) => {
        if (!this.config.devices?.at(0)?.id && peripheral.advertisement.localName !== 'BT_LED') {
          this.log.debug('Ignoring peripheral', peripheral.id, peripheral.advertisement.localName);
          return;
        }
        if (this.found_devices.has(peripheral.id)) {
          this.log.info('Ignoring already found peripheral', peripheral.id);
          return;
        }
        this.log.info('Discovered peripherial', peripheral.id);
        const { id } = peripheral;
        const uuid = this.api.hap.uuid.generate(id);
        if(!peripheral.connectable){
          this.log.info('peripheral not connectable:', id);
          return
        }
        const match_config = this.config.devices?.find((d) => d.id === id);

        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        let acc;
        if (!existingAccessory) {
          this.log.info('Adding new accessory:', id);
          const accessory = new this.api.platformAccessory(match_config?.name ?? "GVM Light", uuid);
          acc = new GVMBleLightAccessory(this, accessory, peripheral);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }else {
          this.log.info('Register existing accessory:', id);
          acc = new GVMBleLightAccessory(this, existingAccessory, peripheral);
        }

        // TODO: maybe use internel all connected peripherials
        this.found_devices.add(id);
        this.connected_preripherals.add(peripheral)
        peripheral.once('disconnect', async (err) => {
          this.log.info('Peripherial disconnected:', id);
          this.log.debug('Reason:', err);
          this.found_devices.delete(id);
          this.connected_preripherals.delete(peripheral);
          wait_for_finding_devices.add(id);
          acc.disconnect().catch(this.log.debug)
          this.startScanning();
        });
        wait_for_finding_devices.delete(id);
        if (wait_for_finding_devices.size === 0 && this.config.devices) {
          await this.stopScanning();
        }else {
          this.log.debug('Still waiting for devices:', Array.from(wait_for_finding_devices));
        }

        acc.connect_and_subscribe(peripheral)
          .catch((err) => {
            this.log.error('Failed to connect', err);
          });
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

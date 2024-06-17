import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import mqtt from "mqtt";

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { HttpLightAccessory } from './platformAccessory.js';

export class HttpLights implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly mqttClient: mqtt.MqttClient;

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
    this.mqttClient = mqtt.connect("mqtt://192.168.1.86:30007");
    this.mqttClient.on("connect", () => {
      this.mqttClient.subscribe("devices", (err) => {
        if (err) {
          this.log.error('Error subscribing devices topic', err)
        } else {
          this.log.info('Subscribed to devices topic')
        }
      })
    });

    this.log.debug('Finished initializing platform:', this.config.name);

    // Homebridge 1.8.0 introduced a `log.success` method that can be used to log success messages
    // For users that are on a version prior to 1.8.0, we need a 'polyfill' for this method
    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      this.mqttClient.on('message', (topic, payload) => {
        const msg = payload.toString()
        // this.log.info(`Message from ${topic} - ${msg}`)

        const { id, state } = JSON.parse(msg)
        const uuid = this.api.hap.uuid.generate(id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (!existingAccessory) {
          this.log.info('Adding new accessory:', id);
          const accessory = new this.api.platformAccessory(id, uuid);
          new HttpLightAccessory(this, accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
      })
      // this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    new HttpLightAccessory(this, accessory);
    this.accessories.push(accessory);
  }

}

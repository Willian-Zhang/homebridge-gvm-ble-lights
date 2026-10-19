/**
 * Runs a light against noble's real JS layer on top of fake bindings, to pin
 * down the connection-lifecycle behaviour the plugin relies on:
 *
 * - a connect that never completes is cancelled at the OS level, otherwise
 *   it completes later behind our back and the light stops advertising
 * - when the adapter goes down, noble emits `disconnect` before it reports the
 *   new state, so the rescan this triggers must only happen afterwards
 *
 * Run with `npm test` (builds first), no light and no Bluetooth needed.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { GVMBleLightAccessory } from '../dist/platformAccessory.js';

// the JS layer only, `@stoprocent/noble` itself would load the native bindings
const Noble = createRequire(import.meta.url)('@stoprocent/noble/lib/noble.js');

const ID = 'aabbccddeeff00112233445566778899';
const CHAR_UUID = '000102030405060708090a0b0c0d2b10';
const TIMEOUT = 200;

/** answers like the native bindings do, `connect` hangs unless told otherwise */
class FakeBindings extends EventEmitter {
  calls = [];
  connects = false;

  later(...args) {
    setImmediate(() => this.emit(...args));
  }

  start() { this.later('stateChange', 'poweredOn'); }
  startScanning() { this.later('scanStart', false); }
  stopScanning() { this.later('scanStop'); }
  connect(id) {
    this.calls.push('connect');
    if (this.connects) {
      this.later('connect', id, null);
    }
  }
  cancelConnect() { this.calls.push('cancelConnect'); }
  disconnect(id) {
    this.calls.push('disconnect');
    this.later('disconnect', id, 'local');
  }
  discoverServices(id) { this.later('servicesDiscover', id, ['fff0']); }
  discoverCharacteristics(id, service) {
    this.later('characteristicsDiscover', id, service, [{ uuid: CHAR_UUID, properties: ['notify', 'writeWithoutResponse'] }]);
  }
  notify(id, service, char, on) { this.later('notify', id, service, char, on); }
  write(id, service, char) { this.later('write', id, service, char); }
}

function stubPlatform() {
  const logged = [];
  const record = (...args) => logged.push(args.join(' '));
  const platform = {
    adapterState: 'unknown',
    /** the adapter state seen by every `startScanning()` call */
    scanRequests: [],
    startScanning: async () => {
      platform.scanRequests.push(platform.adapterState);
    },
    Service: { Lightbulb: 'Lightbulb', AccessoryInformation: 'AccessoryInformation' },
    Characteristic: new Proxy({}, { get: (_target, key) => key }),
    log: { debug: record, info: record, warn: record, error: record, success: record },
    timeout: TIMEOUT,
    api: { hap: { HapStatusError: class HapStatusError extends Error {}, HAPStatus: {} } },
  };
  return { platform, logged };
}

function stubAccessory() {
  const chainable = () => {
    const stub = {};
    for (const name of ['removeOnGet', 'removeOnSet', 'onSet', 'onGet', 'setProps', 'updateCharacteristic']) {
      stub[name] = () => stub;
    }
    return stub;
  };
  const service = {
    getCharacteristic: () => chainable(),
    updateCharacteristic: () => service,
  };
  return { displayName: 'test-light', context: {}, getService: () => service, addService: () => service };
}

const bindings = new FakeBindings();
const noble = new Noble(bindings);
const { platform, logged } = stubPlatform();
noble.on('stateChange', (state) => {
  platform.adapterState = state;
});
await new Promise((resolve) => noble.once('stateChange', resolve));

const discovered = new Promise((resolve) => noble.once('discover', resolve));
bindings.emit('discover', ID, 'unknown', 'unknown', true, { localName: 'BT_LED' }, -50, true);
const peripheral = await discovered;
const light = new GVMBleLightAccessory(platform, stubAccessory());

{
  light.attach(peripheral);
  const started = Date.now();
  await light.connect();
  const took = Date.now() - started;

  assert.equal(light.status, 'idle');
  assert.equal(peripheral.state, 'disconnected');
  assert.deepEqual(bindings.calls, ['connect', 'cancelConnect', 'connect', 'cancelConnect', 'connect', 'cancelConnect']);
  assert.ok(!logged.some((line) => line.startsWith('cancelConnect failed')), 'cancelConnect threw');
  // a cancelled connect must not additionally wait for a disconnect that never comes
  assert.ok(took < 3 * TIMEOUT + 300, `3 attempts should only cost their connect timeouts, took ${took}ms`);
  console.log('ok - a connect that never completes is cancelled at the OS level');
  console.log(`     ${bindings.calls.join(', ')} in ${took}ms`);
}

{
  bindings.calls.length = 0;
  bindings.connects = true;
  light.attach(peripheral);
  await light.connect();
  assert.equal(light.status, 'connected');

  platform.scanRequests.length = 0;
  bindings.emit('stateChange', 'resetting');
  assert.equal(light.status, 'idle', 'the disconnect noble emits while cleaning up reaches the light');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(platform.scanRequests, ['resetting'], 'rescan was requested before the adapter state was known');
  console.log('ok - an adapter reset only asks for a rescan once the new state is known');
}

console.log('\nall checks passed');

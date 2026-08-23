/**
 * Checks the order and the pacing of the BLE commands a HomeKit write produces.
 *
 * The light only applies brightness and color temperature while it is on, and it
 * restores its own latched output when it powers on. HomeKit however writes the
 * characteristics of a scene as separate, concurrent requests and puts `On`
 * last, so the plugin has to collect them and re-order them - that is what is
 * verified here.
 *
 * Run with `npm test` (builds first), no light and no Bluetooth needed.
 */
import assert from 'node:assert/strict';
import { GVMBleLightAccessory } from '../dist/platformAccessory.js';
import { CRCBuffer } from '../dist/bufferHelper.js';

/** the light needs this long after a power-on before it accepts an output change */
const POWER_ON_SETTLE = 250;
/** commands are written without a response, so they have to be paced */
const WRITE_GAP = 50;

const writes = [];

function describe(buffer) {
  assert.equal(buffer.length, 12, `unexpected frame length: ${buffer.toString('hex')}`);
  assert.equal(buffer.subarray(0, 2).toString('hex'), '4c54', 'frame header');
  assert.equal(
    buffer.subarray(10).toString('hex'),
    CRCBuffer(buffer.subarray(0, 10)).toString('hex'),
    `crc of ${buffer.toString('hex')}`,
  );

  const value = buffer[9];
  switch (buffer[7]) {
    case 0x00:
      return value === 1 ? 'on' : 'off';
    case 0x02:
      return `brightness ${value}`;
    case 0x03:
      return `temprature ${value}`;
    default:
      return buffer.toString('hex');
  }
}

function stubLight() {
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
  const platform = {
    Service: { Lightbulb: 'Lightbulb', AccessoryInformation: 'AccessoryInformation' },
    Characteristic: new Proxy({}, { get: (_target, key) => key }),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: console.error, success: () => {} },
    timeout: 1_000,
    api: {
      hap: {
        HapStatusError: class HapStatusError extends Error {},
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      },
    },
  };
  const accessory = {
    displayName: 'test-light',
    context: {},
    getService: () => service,
    addService: () => service,
  };

  const light = new GVMBleLightAccessory(platform, accessory);
  light.peripheral = { id: 'test-light', state: 'connected' };
  light.char = {
    writeAsync: async (buffer) => {
      writes.push({ command: describe(buffer), at: Date.now() });
    },
  };
  return light;
}

/** @returns the commands that were written, and the pause taken in front of each of them */
function taken() {
  const commands = writes.map((write, index) => ({
    command: write.command,
    after: index === 0 ? 0 : write.at - writes[index - 1].at,
  }));
  writes.length = 0;
  return commands;
}

function check(name, commands, expected) {
  const got = commands.map((entry) => entry.command);
  assert.deepEqual(got, expected, `${name}: expected [${expected}], got [${got}]`);

  commands.forEach((entry, index) => {
    if (index === 0) {
      return;
    }
    // a value that follows a power-on has to wait for the light to settle,
    // everything else just has to not flood a single connection interval
    const least = commands[index - 1].command === 'on' ? POWER_ON_SETTLE : WRITE_GAP;
    assert.ok(
      entry.after >= least,
      `${name}: "${entry.command}" followed "${commands[index - 1].command}" after ${entry.after}ms, expected >= ${least}ms`,
    );
  });

  console.log(`ok - ${name}`);
  console.log(`     ${commands.map((entry) => (entry.after ? `+${entry.after}ms ${entry.command}` : entry.command)).join(', ')}`);
}

const light = stubLight();

// HomeKit writes a scene as concurrent requests and deliberately puts `On`
// last - and it repeats `On` - which is exactly what broke before
await Promise.all([
  light.sendTemprature(10_000 / 56),
  light.sendBrightness(45),
  light.sendOnOff(true),
  light.sendOnOff(true),
]);
check('scene: on at 45% / 5600K', taken(), ['on', 'temprature 56', 'brightness 45']);

await light.sendBrightness(20);
check('brightness only, light already on', taken(), ['brightness 20']);

await light.sendOnOff(false);
check('turning off does not touch brightness/temprature', taken(), ['off']);

await light.sendBrightness(20);
await light.sendTemprature(10_000 / 32);
check('values written while off', taken(), ['brightness 20', 'temprature 32']);

// the light would come back up with whatever it showed before it was switched
// off, so both values have to be re-asserted after the power-on
await light.sendOnOff(true);
check('turning on re-asserts the current values', taken(), ['on', 'temprature 32', 'brightness 20']);

// HomeKit's mired range is wider than the 3200K - 5600K the light supports
await light.sendTemprature(140);
check('mired below the supported range is clamped', taken(), ['temprature 56']);

await light.sendTemprature(400);
check('mired above the supported range is clamped', taken(), ['temprature 32']);

console.log('\nall checks passed');

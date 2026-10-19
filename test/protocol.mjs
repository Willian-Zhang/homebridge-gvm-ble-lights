/**
 * Checks the parsing of what the light sends, using frames captured from a
 * real light, plus the malformed frames the parser has to survive.
 *
 * Run with `npm test` (builds first), no light and no Bluetooth needed.
 */
import assert from 'node:assert/strict';
import { GVMBleLightAccessory } from '../dist/platformAccessory.js';
import { CRCBuffer, parseStatus, Register } from '../dist/bufferHelper.js';

/** full status reports captured from a light, before and after switching it from channel 1 to 2 */
const CHANNEL_1 = Buffer.from('4c5409002003010114202d2e', 'hex');
const CHANNEL_2 = Buffer.from('4c540900200301021e34c900', 'hex');

/** frames a frame from its body, i.e. adds the header, the length and the CRC */
function frame(body) {
  const unsigned = Buffer.concat([Buffer.from([0x4c, 0x54, body.length + 2]), body]);
  return Buffer.concat([unsigned, CRCBuffer(unsigned)]);
}

function stubLight() {
  const updates = [];
  const logs = [];
  const chainable = () => {
    const stub = {};
    for (const name of ['removeOnGet', 'removeOnSet', 'onSet', 'onGet', 'setProps', 'updateCharacteristic']) {
      stub[name] = () => stub;
    }
    return stub;
  };
  const service = {
    getCharacteristic: () => chainable(),
    updateCharacteristic: (characteristic, value) => {
      updates.push(`${characteristic}=${value}`);
      return service;
    },
  };
  const record = (level) => (...args) => logs.push(`${level}: ${args.join(' ')}`);
  const platform = {
    Service: { Lightbulb: 'Lightbulb', AccessoryInformation: 'AccessoryInformation' },
    Characteristic: new Proxy({}, { get: (_target, key) => key }),
    log: { debug: () => {}, info: record('info'), warn: record('warn'), error: record('error'), success: () => {} },
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
  // drop the accessory information the constructor sets
  updates.length = 0;
  logs.length = 0;
  return {
    light,
    /** @returns what reached HomeKit and the log since the last call */
    taken() {
      const result = { updates: [...updates], logs: [...logs] };
      updates.length = 0;
      logs.length = 0;
      return result;
    },
  };
}

function ok(name) {
  console.log(`ok - ${name}`);
}

/** the body of a status report as `onStateChangeAll` gets it: without header, length, `00 20` and CRC */
const statusBody = (captured) => captured.subarray(5, captured.length - 2);

assert.deepEqual(parseStatus(statusBody(CHANNEL_1)), { on: true, channel: 1, brightness: 20, temprature: 32 });
assert.deepEqual(parseStatus(statusBody(CHANNEL_2)), { on: true, channel: 2, brightness: 30, temprature: 52 });
assert.equal(parseStatus(Buffer.from('03010114', 'hex')), undefined);
ok('parseStatus decodes the captured reports, and rejects a short one');

for (const captured of [CHANNEL_1, CHANNEL_2]) {
  assert.deepEqual(frame(Buffer.concat([Buffer.from('0020', 'hex'), statusBody(captured)])), captured);
}
ok('re-framing the captured reports reproduces them, CRC included');

{
  const { light, taken } = stubLight();
  light.onNotification(CHANNEL_1);
  assert.deepEqual(taken(), {
    updates: ['On=true', 'Brightness=20', `ColorTemperature=${10_000 / 32}`],
    logs: ['info: test-light: on channel 1'],
  });
  light.onNotification(CHANNEL_1);
  assert.deepEqual(taken().logs, [], 'an unchanged channel is not logged again');
  light.onNotification(CHANNEL_2);
  assert.deepEqual(taken(), {
    updates: ['On=true', 'Brightness=30', `ColorTemperature=${10_000 / 52}`],
    logs: ['info: test-light: channel changed from 1 to 2'],
  });
  ok('a status report reaches HomeKit, and a channel change is logged once');
}

{
  const { light, taken } = stubLight();
  light.onNotification(Buffer.concat([CHANNEL_1, CHANNEL_2]));
  const { updates, logs } = taken();
  assert.deepEqual(updates.filter((update) => update.startsWith('Brightness')), ['Brightness=20', 'Brightness=30']);
  assert.deepEqual(logs, ['info: test-light: on channel 1', 'info: test-light: channel changed from 1 to 2']);
  ok('a notification holding two frames applies both');
}

{
  // synthetic: no single-register channel update has been seen from a light yet
  const { light, taken } = stubLight();
  light.onNotification(frame(Buffer.from([0x00, 0x20, 0x02, 0x00, Register.CHANNEL, 0x03])));
  assert.deepEqual(taken(), { updates: [], logs: ['info: test-light: on channel 3'] });
  ok('a single-register channel update is understood');
}

{
  const { light, taken } = stubLight();
  light.onNotification(CHANNEL_1.subarray(0, CHANNEL_1.length - 1));
  const { updates, logs } = taken();
  assert.deepEqual(updates, []);
  assert.match(logs.join('\n'), /^error: len error/);
  ok('a truncated frame is a length error');
}

{
  const { light, taken } = stubLight();
  light.onNotification(Buffer.concat([CHANNEL_1, Buffer.from('ffff', 'hex')]));
  const { updates, logs } = taken();
  assert.equal(updates.length, 3, 'the valid first frame is still applied');
  assert.match(logs.at(-1), /^error: header error, rests ffff/);
  ok('a bad header after a valid frame is reported, not thrown');
}

{
  const { light, taken } = stubLight();
  const corrupted = Buffer.from(CHANNEL_1);
  corrupted[8] = 0x15;
  light.onNotification(corrupted);
  const { updates, logs } = taken();
  assert.deepEqual(updates, []);
  assert.match(logs.join('\n'), /^error: crc error/);
  ok('a corrupted frame fails the CRC check');
}

console.log('\nall checks passed');

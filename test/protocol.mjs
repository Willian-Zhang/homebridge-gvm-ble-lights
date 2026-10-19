/**
 * Checks the parsing of what the light sends, using frames captured from a
 * real light, plus the malformed frames the parser has to survive.
 *
 * Run with `npm test` (builds first), no light and no Bluetooth needed.
 */
import assert from 'node:assert/strict';
import { GVMBleLightAccessory } from '../dist/platformAccessory.js';
import { CRCBuffer, parseStatus, heartbeatReply, infoAll, onoff, brightness, temprature } from '../dist/bufferHelper.js';

/** full status reports captured from a light, before and after switching it from channel 1 to 2 */
const CHANNEL_1 = Buffer.from('4c5409002003010114202d2e', 'hex');
const CHANNEL_2 = Buffer.from('4c540900200301021e34c900', 'hex');

/**
 * captured between the GVM app and a light (PacketLogger, 2026-10-19): a status
 * report (on, channel 1, 15 %, 4400K) and the app's answer to it
 */
const REPORT = Buffer.from('4c540900200301010f2c332b', 'hex');
const APP_REPLY = Buffer.from('4c540900204801010f2ccebc', 'hex');
/** the light's answer to the app's (and our) `infoAll()` */
const INFO_REPLY = Buffer.from('4c540a00205300000220381c62', 'hex');
/** the light confirming single register writes: brightness 14, channel 2 */
const BRIGHTNESS_14 = Buffer.from('4c540800200200020edf1d', 'hex');
const CHANNEL_SET_2 = Buffer.from('4c54080020020001024bc2', 'hex');
/** commands the app wrote */
const APP_COMMANDS = {
  infoAll: '4c5409000053000001009474',
  off: '4c540900205700000100287a',
  on: '4c540900205700000101385b',
  brightness100: '4c5409002057000201646a38',
  temprature56: '4c540900205700030138c671',
};

/** frames a frame from its body, i.e. adds the header, the length and the CRC */
function frame(body) {
  const unsigned = Buffer.concat([Buffer.from([0x4c, 0x54, body.length + 2]), body]);
  return Buffer.concat([unsigned, CRCBuffer(unsigned)]);
}

function stubLight({ connected = false } = {}) {
  const updates = [];
  const logs = [];
  const writes = [];
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
  if (connected) {
    light.char = { writeAsync: async (buffer) => writes.push(buffer.toString('hex')) };
    light.connectionStatus = 'connected';
  }
  // drop the accessory information the constructor sets
  updates.length = 0;
  logs.length = 0;
  return {
    light,
    writes,
    /** waits until everything the light queued has been written */
    settled: () => light.queue,
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
  const { light, taken } = stubLight();
  light.onNotification(CHANNEL_SET_2);
  assert.deepEqual(taken(), { updates: [], logs: ['info: test-light: on channel 2'] });
  light.onNotification(BRIGHTNESS_14);
  assert.deepEqual(taken(), { updates: ['Brightness=14'], logs: ['info: < brightness 14'] });
  ok('the captured single-register confirmations are understood');
}

{
  assert.equal(infoAll().toString('hex'), APP_COMMANDS.infoAll);
  assert.equal(onoff(0).toString('hex'), APP_COMMANDS.off);
  assert.equal(onoff(1).toString('hex'), APP_COMMANDS.on);
  assert.equal(brightness(100).toString('hex'), APP_COMMANDS.brightness100);
  assert.equal(temprature(56).toString('hex'), APP_COMMANDS.temprature56);
  ok('our commands are byte for byte what the GVM app sends');
}

{
  assert.deepEqual(heartbeatReply(statusBody(REPORT)), APP_REPLY);
  const { light, taken, writes, settled } = stubLight({ connected: true });
  light.onNotification(REPORT);
  await settled();
  assert.deepEqual(writes, [APP_REPLY.toString('hex')]);
  assert.deepEqual(taken().updates, ['On=true', 'Brightness=15', `ColorTemperature=${10_000 / 44}`]);
  ok('a status report is answered like the GVM app does');
}

{
  const { light, writes, settled } = stubLight();
  light.onNotification(REPORT);
  await settled();
  assert.deepEqual(writes, [], 'not connected yet');

  const busy = stubLight({ connected: true });
  const command = busy.light.sendBuffer(onoff(0));
  busy.light.onNotification(REPORT);
  await command;
  await busy.settled();
  assert.deepEqual(busy.writes, [APP_COMMANDS.off], 'the echo would carry the state from before the command');
  ok('a status report is not answered while not connected or while a command is queued');
}

{
  const { light, taken, writes, settled } = stubLight({ connected: true });
  light.onNotification(INFO_REPLY);
  await settled();
  assert.deepEqual(taken(), { updates: [], logs: [] }, 'not reported as unrecognized');
  assert.deepEqual(writes, []);
  ok('the reply to infoAll() is understood');
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

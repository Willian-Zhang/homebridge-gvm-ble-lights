import CRC16 from 'crc/calculators/crc16xmodem';
type UInt8 = number & { __brand: "uint8" };

/** the light's registers, also the order of the values in a full status report */
export const Register = {
    ON: 0x00,
    /**
     * the channel selected on the light. The GVM app writes it like any other
     * register and the link stays up; only changing it on the light drops it.
     */
    CHANNEL: 0x01,
    BRIGHTNESS: 0x02,
    TEMPRATURE: 0x03,
} as const;

export type Status = {
    on: boolean;
    channel: number;
    brightness: number;
    /** raw device value, 32 - 56 */
    temprature: number;
};

/**
 * Parses the body of a full status report, which the light sends unprompted
 * about every 5s while connected, without the `00 20` prefix and the CRC:
 * `03 <on> <channel> <brightness> <temprature>`.
 * @returns undefined when the report is too short
 */
export function parseStatus(cmd: Buffer): Status | undefined {
    const values = cmd.subarray(1);
    if (values.length <= Register.TEMPRATURE) {
        return undefined;
    }
    return {
        on: values[Register.ON] === 1,
        channel: values[Register.CHANNEL],
        brightness: values[Register.BRIGHTNESS],
        temprature: values[Register.TEMPRATURE],
    };
}


export function CRCBuffer(data: Buffer) {
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(CRC16(data));
    return crc;
  }

/** wraps a body into a frame: "LT", the length of the rest, the body, the CRC */
function frame(body: Buffer) {
    const unsigned = Buffer.concat([Buffer.from([0x4C, 0x54, body.length + 2]), body]);
    return Buffer.concat([unsigned, CRCBuffer(unsigned)]);
}

/**
 * The GVM app answers every full status report right away by echoing its
 * values with `48` ('H') in place of `03`, e.g. `03 01 01 0f 2c` ->
 * `48 01 01 0f 2c`. Not doing so keeps the link up as well, the reply mirrors
 * the app in case the light relies on it for something else.
 * @param report the body of the report as `parseStatus` gets it
 */
export function heartbeatReply(report: Buffer) {
    return frame(Buffer.concat([Buffer.from([0x00, 0x20, 0x48]), report.subarray(1)]));
}

  
export function formCmd(subcmd: UInt8, value: UInt8) {
    const cmd = Buffer.from([0x4C, 0x54, 0x09, 0x00, 0x20, 0x57, 0x00, subcmd, 0x01, 0x00]);
    cmd.writeInt8(value, 9);
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(CRC16(cmd));
    return Buffer.concat([cmd, crc]);
}

export function onoff(value: number) {
    // 0x00 - 0x01
    return formCmd(Register.ON as UInt8, value as UInt8);
}

export function brightness(value: number) {
    // 0x00 - 0x64
    return formCmd(Register.BRIGHTNESS as UInt8, value as UInt8);
}

export function temprature(value: number) {
    // 0x20 - 0x38 (32-56) 3200k - 5600k
    return formCmd(Register.TEMPRATURE as UInt8, value as UInt8);
}

export function start_with(buffer: Buffer, check_buffer: Buffer) {
    const len = check_buffer.length;
    if (buffer.length < len) {
        return false;
    }
    if (check_buffer.compare(buffer.subarray(0, len)) != 0) {
        return false;
    }
    return true;
}
/**
 * The request the GVM app sends right after connecting. Despite the name it is
 * not answered with a status report but with `53 00 00 02 <min> <max>`, `20 38`
 * (3200K - 5600K) on the lights seen so far - presumably the color temperature
 * range. Any answer proves the link is alive, which is what it is used for.
 */
export function infoAll(){
    const cmd = Buffer.from([0x4C ,0x54 ,0x09 ,0x00 ,0x00 ,0x53 ,0x00 ,0x00 ,0x01 ,0x00]);
    const crc = CRCBuffer(cmd);
    return Buffer.concat([cmd, crc]);
}
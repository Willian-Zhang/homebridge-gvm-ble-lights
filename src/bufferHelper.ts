import CRC16 from 'crc/calculators/crc16xmodem';
type UInt8 = number & { __brand: "uint8" };


export function CRCBuffer(data: Buffer) {
    const crc = Buffer.alloc(2);
    crc.writeUInt16BE(CRC16(data));
    return crc;
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
    return formCmd(0x00 as UInt8, value as UInt8);
}

export function brightness(value: number) {
    // 0x00 - 0x64
    return formCmd(0x02 as UInt8, value as UInt8);
}

export function temprature(value: number) {
    // 0x20 - 0x38 (32-56) 3200k - 5600k
    return formCmd(0x03 as UInt8, value as UInt8);
}

export function start_with(buffer: Buffer, check_buffer: Buffer) {
    let len = check_buffer.length;
    if (buffer.length < len) {
        return false;
    }
    if (check_buffer.compare(buffer.subarray(0, len)) != 0) {
        return false;
    }
    return true;
}
export function infoAll(){
    const cmd = Buffer.from([0x4C ,0x54 ,0x09 ,0x00 ,0x00 ,0x53 ,0x00 ,0x00 ,0x01 ,0x00]);
    let crc = CRCBuffer(cmd);
    return Buffer.concat([cmd, crc]);
}
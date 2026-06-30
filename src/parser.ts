import { vec3 } from 'gl-matrix';
import type { InputState, IMUSample } from './types.js';
import { US_PER_IMU_SAMPLE } from './constants.js';

export function parseInputState(data: DataView): InputState {
  const buttonByte = data.getUint8(0);
  return {
    buttons: {
      trigger: false, // set by ZapboxController after analog processing
      a: !!(buttonByte & 0x01),
      b: !!(buttonByte & 0x02),
      menu: !!(buttonByte & 0x04),
      grip: !!(buttonByte & 0x08),
      thumbstickClick: !!(buttonByte & 0x10),
    },
    trigger: data.getUint8(1),
    thumbstickX: data.getUint8(2),
    thumbstickY: data.getUint8(3),
  };
}

export class IMUSampleParser {
  private readonly isV2: boolean;
  private readonly is16UsTimestamp: boolean;

  // V1: rolling sample counter (16-bit low bits + extended high bits)
  private prevImuSampleLowBits = 0;
  private imuSampleHighBits = 0;

  // V2: per-sample timestamp with same overflow extension
  private prevImuTimestampLowBits = 0;
  private imuTimestampHighBits = 0;

  constructor(major: number, minor: number) {
    this.isV2 = major >= 2 || (major === 1 && minor >= 10);
    // 16us resolution timestamps were added in firmware 2.4
    this.is16UsTimestamp = major > 2 || (major === 2 && minor >= 4);
  }

  parse(data: DataView): IMUSample[] {
    const samples: IMUSample[] = [];
    const dataLen = data.byteLength;

    const imuStart = this.isV2 ? 4 : 8;
    const imuEnd = this.isV2 ? dataLen - 13 : dataLen - 11;
    const imuLen = this.isV2 ? 14 : 12;

    // V1: establish the base sample counter from the header before looping
    let imuSample = 0;
    if (!this.isV2) {
      const lowBits = data.getUint16(4, false);
      if (lowBits < this.prevImuSampleLowBits) {
        this.imuSampleHighBits += 1 << 16;
      }
      this.prevImuSampleLowBits = lowBits;
      imuSample = this.imuSampleHighBits + lowBits;
    }

    for (let idx = imuStart; idx < imuEnd; idx += imuLen) {
      const accel = vec3.fromValues(
        data.getInt16(idx + 0, false),
        data.getInt16(idx + 2, false),
        data.getInt16(idx + 4, false),
      );
      const gyro = vec3.fromValues(
        data.getInt16(idx + 6,  false),
        data.getInt16(idx + 8,  false),
        data.getInt16(idx + 10, false),
      );

      let timestampUs: number;
      if (this.isV2) {
        const lowBits = data.getUint16(idx + 12, false);
        if (lowBits < this.prevImuTimestampLowBits) {
          this.imuTimestampHighBits += 1 << 16;
        }
        this.prevImuTimestampLowBits = lowBits;
        timestampUs = (this.imuTimestampHighBits + lowBits) * (this.is16UsTimestamp ? 16 : 1);
      } else {
        timestampUs = imuSample * US_PER_IMU_SAMPLE;
        imuSample++;
      }

      samples.push({ accel, gyro, timestampUs });
    }

    return samples;
  }
}

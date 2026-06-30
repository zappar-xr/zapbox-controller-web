export const SERVICE_UUID = '121a0001-f6e4-4bb8-aec5-9e814ab54443';
export const STREAMING_DATA_UUID = '121a0002-f6e4-4bb8-aec5-9e814ab54443';
export const CONNECTION_INTERVAL_UUID = '121a0003-f6e4-4bb8-aec5-9e814ab54443';
export const INFO_UUID = '121a0004-f6e4-4bb8-aec5-9e814ab54443';

export const IMU_SAMPLE_RATE_HZ = 200;
export const US_PER_IMU_SAMPLE = 1_000_000 / IMU_SAMPLE_RATE_HZ; // 5000 us

// Accel: full-scale +-32768 = +-16 g
export const ACCEL_SCALE = (16 * 9.80665) / 32768;
// Gyro: full-scale +-32768 = +-2000 deg/s
export const GYRO_SCALE = (2000 * Math.PI) / (180 * 32768);

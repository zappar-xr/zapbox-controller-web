export class AutoCalibratedAnalogTrigger {
  private readonly safeMin = 65;
  private readonly safeMax = 100;

  private calibratedMin: number;
  private calibratedMax: number;
  private calibratedMinWithDeadzone: number;
  private calibratedMaxWithDeadzone: number;
  private calibratedScale: number;

  private overallMin: number;
  private overallMax: number;
  private stableMin: number;
  private stableMax: number;

  private readonly windowSamples = 4;
  private windowIndex = 0;
  private windowMin = 255;
  private windowMax = 0;

  constructor() {
    this.calibratedMin = this.safeMin;
    this.calibratedMax = this.safeMax;
    this.calibratedMinWithDeadzone = this.safeMin;
    this.calibratedMaxWithDeadzone = this.safeMax;
    this.calibratedScale = 1 / (this.safeMax - this.safeMin);
    this.overallMin = this.safeMin;
    this.overallMax = this.safeMax;
    this.stableMin = this.safeMin;
    this.stableMax = this.safeMax;
  }

  processSample(sample: number): number {
    let rangeUpdated = false;

    if (sample < this.overallMin) {
      this.overallMin = sample;
      if (this.stableMin >= this.safeMin) {
        this.calibratedMin = this.overallMin;
        rangeUpdated = true;
      }
    }
    if (sample > this.overallMax) {
      this.overallMax = sample;
      if (this.stableMax <= this.safeMax) {
        this.calibratedMax = this.overallMax;
        rangeUpdated = true;
      }
    }

    if (this.windowIndex === 0) {
      this.windowMin = sample;
      this.windowMax = sample;
    } else {
      if (sample < this.windowMin) this.windowMin = sample;
      if (sample > this.windowMax) this.windowMax = sample;
    }
    this.windowIndex++;

    if (this.windowIndex === this.windowSamples) {
      if (this.windowMax - this.windowMin <= 3) {
        if (this.windowMin < this.stableMin) {
          this.stableMin = this.windowMin;
          this.calibratedMin = this.stableMin;
          rangeUpdated = true;
        }
        if (this.windowMax > this.stableMax) {
          this.stableMax = this.windowMax;
          this.calibratedMax = this.stableMax;
          rangeUpdated = true;
        }
      }
      this.windowIndex = 0;
    }

    if (rangeUpdated) {
      const deadzone = Math.floor((this.calibratedMax - this.calibratedMin) / 7);
      this.calibratedMinWithDeadzone = this.calibratedMin + deadzone;
      this.calibratedMaxWithDeadzone = this.calibratedMax - deadzone;
      this.calibratedScale = 1 / (this.calibratedMaxWithDeadzone - this.calibratedMinWithDeadzone);
    }

    if (sample <= this.calibratedMinWithDeadzone) return 0;
    if (sample >= this.calibratedMaxWithDeadzone) return 1;
    return this.calibratedScale * (sample - this.calibratedMinWithDeadzone);
  }

  reset(): void {
    this.calibratedMin = this.safeMin;
    this.calibratedMax = this.safeMax;
    this.calibratedMinWithDeadzone = this.safeMin;
    this.calibratedMaxWithDeadzone = this.safeMax;
    this.calibratedScale = 1 / (this.safeMax - this.safeMin);
    this.overallMin = this.safeMin;
    this.overallMax = this.safeMax;
    this.stableMin = this.safeMin;
    this.stableMax = this.safeMax;
    this.windowIndex = 0;
    this.windowMin = 255;
    this.windowMax = 0;
  }
}

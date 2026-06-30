import { vec3 } from "gl-matrix";

// Two-half-window design: accumulates two separate running totals over consecutive
// half-windows rather than a single subtract-oldest/add-newest accumulator.
// Keeps average computation O(1) while avoiding floating-point drift from
// repeated subtraction of old values from a long-lived sum.
export class Vec3RollingAverage {

	public current = vec3.create();

	private samples: vec3[] = [];
	private numSamples = 0;
	private scaleFactor = 1;
	private nextIndex = 0;
	private rollingTotal = vec3.create();
	private previousTotal = vec3.create();

	constructor(private maxSamples = 5) {
		for(let i = 0; i < maxSamples; i++) {
			this.samples.push(vec3.create());
		}
	}

	public reset(): void {
		this.numSamples = 0;
		this.scaleFactor = 1;
		this.nextIndex = 0;
		vec3.zero(this.rollingTotal);
		vec3.zero(this.previousTotal);
		vec3.zero(this.current);
	}

	public addSample(sample: vec3) {
		if(this.numSamples == this.maxSamples) {
			// Will be a replacement of something in the previous total
			vec3.sub(this.previousTotal, this.previousTotal, this.samples[this.nextIndex]);
		} else {
			// Will be a new sample
			this.numSamples++;
			this.scaleFactor = 1.0 / this.numSamples;
		}

		vec3.copy(this.samples[this.nextIndex], sample);
		vec3.add(this.rollingTotal, this.rollingTotal, sample);

		this.nextIndex++;

		// Update the current average
		if(this.nextIndex == this.maxSamples) {
			// Reached the end, rollingTotal is the full total
			vec3.scale(this.current, this.rollingTotal, this.scaleFactor);
			// Update the state for rollover
			vec3.copy(this.previousTotal, this.rollingTotal);
			vec3.zero(this.rollingTotal);
			this.nextIndex = 0;
		} else {
			// Part way through, overall total is runningTotal + previousTotal
			vec3.add(this.current, this.rollingTotal, this.previousTotal);
			vec3.scale(this.current, this.current, this.scaleFactor);
		}
	}

}

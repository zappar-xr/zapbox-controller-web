import { vec3 } from 'gl-matrix';

// Tracks the per-axis min/max/range of a vec3 signal over a rolling window of exactly
// `windowSize` samples using a segment tree with variable-length layers.
// Each layer is ceil(prevLayer.length / 2) long — no phantom padding entries.
// Three independent per-dimension trees allow early termination per axis and dimension.
// O(log windowSize) per sample worst case; typically less due to early termination.
export class Vec3RollingRange {
  private readonly treeMins: Float32Array[][];
  private readonly treeMaxes: Float32Array[][];
  private readonly rootLayer: number;
  private head = 0;
  private initialized = false;

  private _range = vec3.create();
  private _currentMin = vec3.create();
  private _currentMax = vec3.create();

  constructor(private readonly windowSize: number) {
    const layerLengths: number[] = [];
    let size = windowSize;
    while (true) {
      layerLengths.push(size);
      if (size === 1) break;
      size = Math.ceil(size / 2);
    }
    this.rootLayer = layerLengths.length - 1;
    this.treeMins = [
      layerLengths.map(n => new Float32Array(n)),
      layerLengths.map(n => new Float32Array(n)),
      layerLengths.map(n => new Float32Array(n)),
    ];
    this.treeMaxes = [
      layerLengths.map(n => new Float32Array(n)),
      layerLengths.map(n => new Float32Array(n)),
      layerLengths.map(n => new Float32Array(n)),
    ];
  }

  get range(): vec3 { return this._range; }
  get currentMin(): vec3 { return this._currentMin; }
  get currentMax(): vec3 { return this._currentMax; }
  get maxRange(): number {
    return Math.max(this._range[0], this._range[1], this._range[2]);
  }

  addSample(sample: vec3): void {
    if (!this.initialized) {
      // Copy first sample into every node in every layer — no computation needed
      // since min(x,x)=x. Initial range is [0,0,0], widening as distinct values arrive.
      for (let dim = 0; dim < 3; dim++) {
        const v = sample[dim];
        for (let k = 0; k <= this.rootLayer; k++) {
          this.treeMins[dim][k].fill(v);
          this.treeMaxes[dim][k].fill(v);
        }
      }
      this.initialized = true;
    }

    for (let dim = 0; dim < 3; dim++) {
      const v = sample[dim];

      // Min update for this dimension
      let oldChildMin = this.treeMins[dim][0][this.head];
      this.treeMins[dim][0][this.head] = v;
      let newChildMin = v;

      for (let k = 1; k <= this.rootLayer; k++) {
        const j = this.head >> k;
        const nodeMin = this.treeMins[dim][k][j];
        let newNodeMin = nodeMin;

        if (newChildMin < nodeMin) {
          newNodeMin = newChildMin;
        } else if (newChildMin === nodeMin || oldChildMin > nodeMin) {
          // New value maintains current min, or old child wasn't the source — unchanged
          break;
        } else {
          // oldChildMin === nodeMin and newChildMin > nodeMin:
          // old child was the source and new is worse — must check sibling
          const siblingIdx = (this.head >> (k - 1)) ^ 1;
          const layerBelow = this.treeMins[dim][k - 1];
          newNodeMin = siblingIdx < layerBelow.length
            ? Math.min(newChildMin, layerBelow[siblingIdx])
            : newChildMin;
          if (newNodeMin === nodeMin) break;
        }

        oldChildMin = nodeMin;
        newChildMin = newNodeMin;
        this.treeMins[dim][k][j] = newNodeMin;
      }

      // Max update for this dimension (symmetric)
      let oldChildMax = this.treeMaxes[dim][0][this.head];
      this.treeMaxes[dim][0][this.head] = v;
      let newChildMax = v;

      for (let k = 1; k <= this.rootLayer; k++) {
        const j = this.head >> k;
        const nodeMax = this.treeMaxes[dim][k][j];
        let newNodeMax = nodeMax;

        if (newChildMax > nodeMax) {
          newNodeMax = newChildMax;
        } else if (newChildMax === nodeMax || oldChildMax < nodeMax) {
          break;
        } else {
          const siblingIdx = (this.head >> (k - 1)) ^ 1;
          const layerBelow = this.treeMaxes[dim][k - 1];
          newNodeMax = siblingIdx < layerBelow.length
            ? Math.max(newChildMax, layerBelow[siblingIdx])
            : newChildMax;
          if (newNodeMax === nodeMax) break;
        }

        oldChildMax = nodeMax;
        newChildMax = newNodeMax;
        this.treeMaxes[dim][k][j] = newNodeMax;
      }
    }

    for (let dim = 0; dim < 3; dim++) {
      this._currentMin[dim] = this.treeMins[dim][this.rootLayer][0];
      this._currentMax[dim] = this.treeMaxes[dim][this.rootLayer][0];
      this._range[dim] = this._currentMax[dim] - this._currentMin[dim];
    }

    this.head = (this.head + 1) % this.windowSize;
  }

  reset(): void {
    this.initialized = false;
    this.head = 0;
    vec3.zero(this._range);
    vec3.zero(this._currentMin);
    vec3.zero(this._currentMax);
  }
}

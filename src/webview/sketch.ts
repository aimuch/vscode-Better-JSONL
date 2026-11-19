// Zero-dependency streaming sketches:
// 1. Log-bucket DDSketch-inspired quantile estimator (O(1) memory, ~1% relative accuracy)
// 2. HyperLogLog (p=10, m=1024 registers) distinct cardinality estimator (O(1) memory)

/** Streaming quantile sketch with O(1) bounded memory (~1% relative error). */
export class QuantileSketch {
  private readonly gamma: number;
  private readonly logGamma: number;
  private readonly pos = new Map<number, number>();
  private readonly neg = new Map<number, number>();
  private zeros = 0;
  private total = 0;
  private _min = Infinity;
  private _max = -Infinity;
  private _sum = 0;

  constructor(relativeAccuracy = 0.01) {
    this.gamma = (1 + relativeAccuracy) / (1 - relativeAccuracy);
    this.logGamma = Math.log(this.gamma);
  }

  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.total++;
    this._sum += v;
    if (v < this._min) this._min = v;
    if (v > this._max) this._max = v;
    if (v === 0) {
      this.zeros++;
      return;
    }
    const abs = Math.abs(v);
    const idx = Math.ceil(Math.log(abs) / this.logGamma);
    const map = v > 0 ? this.pos : this.neg;
    map.set(idx, (map.get(idx) ?? 0) + 1);
  }

  get count(): number {
    return this.total;
  }

  get sum(): number {
    return this._sum;
  }

  get min(): number {
    return this.total ? this._min : NaN;
  }

  get max(): number {
    return this.total ? this._max : NaN;
  }

  get avg(): number {
    return this.total ? this._sum / this.total : NaN;
  }

  quantile(q: number): number {
    if (this.total === 0) return NaN;
    const clamped = Math.max(0, Math.min(1, q));
    if (clamped === 0) return this._min;
    if (clamped === 1) return this._max;
    const targetRank = clamped * (this.total - 1);
    let acc = 0;

    // Negative buckets from most negative (largest idx) to closest to 0 (smallest idx).
    if (this.neg.size > 0) {
      const negKeys = [...this.neg.keys()].sort((a, b) => b - a);
      for (const k of negKeys) {
        const c = this.neg.get(k)!;
        if (acc + c > targetRank) {
          const val = -Math.pow(this.gamma, k - 0.5);
          return Math.max(this._min, Math.min(this._max, val));
        }
        acc += c;
      }
    }

    // Zeros
    if (this.zeros > 0) {
      if (acc + this.zeros > targetRank) return 0;
      acc += this.zeros;
    }

    // Positive buckets from smallest idx to largest idx.
    if (this.pos.size > 0) {
      const posKeys = [...this.pos.keys()].sort((a, b) => a - b);
      for (const k of posKeys) {
        const c = this.pos.get(k)!;
        if (acc + c > targetRank) {
          const val = Math.pow(this.gamma, k - 0.5);
          return Math.max(this._min, Math.min(this._max, val));
        }
        acc += c;
      }
    }

    return this._max;
  }
}

/**
 * Compact HyperLogLog++ (p=10, 1024 registers = 1 KB) with exact Set fallback for small cardinalities (<= 256).
 */
export class DistinctCounter {
  private exact: Set<string> | null = new Set();
  private regs: Uint8Array | null = null;
  private static readonly EXACT_LIMIT = 256;
  private static readonly P = 10;
  private static readonly M = 1 << DistinctCounter.P; // 1024
  private static readonly ALPHA = 0.7213 / (1 + 1.079 / DistinctCounter.M);

  private static hash32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // Murmur3 finalizer for strong avalanche across upper/lower bits
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  private addReg(s: string): void {
    const h = DistinctCounter.hash32(s);
    const idx = h >>> (32 - DistinctCounter.P);
    const rem = (h << DistinctCounter.P) >>> 0;
    const rho = rem === 0 ? 32 - DistinctCounter.P + 1 : Math.clz32(rem) + 1;
    if (rho > this.regs![idx]) this.regs![idx] = rho;
  }

  add(key: string): void {
    if (this.exact) {
      this.exact.add(key);
      if (this.exact.size > DistinctCounter.EXACT_LIMIT) {
        this.regs = new Uint8Array(DistinctCounter.M);
        for (const k of this.exact) this.addReg(k);
        this.exact = null;
      }
    } else {
      this.addReg(key);
    }
  }

  get isExact(): boolean {
    return this.exact !== null;
  }

  estimate(): number {
    if (this.exact) return this.exact.size;
    const regs = this.regs!;
    const m = DistinctCounter.M;
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < m; i++) {
      const r = regs[i];
      if (r === 0) zeros++;
      sum += Math.pow(2, -r);
    }
    let est = (DistinctCounter.ALPHA * m * m) / sum;
    if (est <= 2.5 * m && zeros > 0) {
      est = m * Math.log(m / zeros);
    }
    return Math.round(est);
  }
}

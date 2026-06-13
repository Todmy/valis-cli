import { describe, expect, it } from 'vitest';

import { accepts, measureVarianceBand } from '../../../src/ape/optimizer/accept.js';

describe('measureVarianceBand', () => {
  it('band = 2σ of repeats', () => {
    // scores [0.1, 0.2, 0.3, 0.4, 0.5]: mean 0.3, population variance 0.02,
    // stdev sqrt(0.02) ≈ 0.1414213562 → band = 2σ ≈ 0.2828427125.
    const band = measureVarianceBand([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(band).toBeCloseTo(2 * Math.sqrt(0.02), 10);
  });

  it('K<2 → throws', () => {
    expect(() => measureVarianceBand([0.3])).toThrow();
    expect(() => measureVarianceBand([])).toThrow();
  });
});

describe('accepts', () => {
  it('accepts only when delta exceeds band', () => {
    expect(accepts(0.5, 0.9, 0.2)).toBe(true);
  });

  it('rejects within-band noise', () => {
    // delta 0.1 < band 0.2 → noise, reject.
    expect(accepts(0.5, 0.6, 0.2)).toBe(false);
    // delta exactly equal to band → not strictly greater → reject.
    expect(accepts(0.5, 0.7, 0.2)).toBe(false);
  });
});

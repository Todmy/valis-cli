/**
 * 285/T018: variance-band acceptance rule.
 *
 * Acceptance (pinned decision): K=5 repeats of a fixed prompt → variance band
 * = 2σ; a candidate is accepted only if it beats the baseline by MORE than the
 * band on held-out. The band guards against accepting within-noise candidates.
 *
 * Pure math — no I/O, no dependencies. Fail-loud when variance is unestimable.
 */

/**
 * Variance band = 2 × population standard deviation of K repeat scores.
 *
 * Needs at least 2 repeats to estimate spread — `K<2` throws (fail-loud:
 * silently returning 0 would accept any non-zero delta as significant).
 */
export function measureVarianceBand(scores: number[]): number {
  if (scores.length < 2) {
    throw new Error(
      `measureVarianceBand: need at least 2 repeats to estimate variance (got ${scores.length})`,
    );
  }
  const mean = scores.reduce((acc, s) => acc + s, 0) / scores.length;
  const variance =
    scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;
  return 2 * Math.sqrt(variance);
}

/**
 * A candidate is accepted iff its score beats the baseline by STRICTLY more
 * than the variance band — a delta within (or equal to) the band is noise.
 */
export function accepts(baseline: number, candidate: number, band: number): boolean {
  return candidate - baseline > band;
}

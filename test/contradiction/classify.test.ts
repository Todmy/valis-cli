/**
 * 044/T004: opposition classifier contract.
 *
 * No live LLM — a fake `fetchImpl` returns canned Anthropic responses. Verifies
 * the non-throwing abstention contract and the symmetrized two-pass.
 */
import { describe, it, expect } from 'vitest';
import {
  makeHaikuClassifier,
  parseLabel,
  type DecisionLite,
} from '../../src/contradiction/classify.js';

const A: DecisionLite = { id: 'a', summary: 'Use Firecrawl over Apify for cost', detail: 'x' };
const B: DecisionLite = { id: 'b', summary: 'Drop Firecrawl, move to Apify', detail: 'y' };

/** Build a fake fetch that returns the given label (same for both passes). */
function fakeFetch(label: string, confidence = 0.9): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ label, confidence }) }] }),
    }) as unknown as Response) as typeof fetch;
}

/** Fake fetch that returns a different label on each successive call. */
function fakeFetchSequence(labels: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const label = labels[i % labels.length];
    i++;
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ label, confidence: 0.8 }) }] }),
    } as unknown as Response;
  }) as typeof fetch;
}

describe('makeHaikuClassifier — abstention contract (Constitution IV)', () => {
  it('abstains with no apiKey — never calls the network', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as Response;
    }) as typeof fetch;
    const classify = makeHaikuClassifier({ fetchImpl });
    const v = await classify(A, B);
    expect(v).toEqual({ classification: 'uncertain', confidence: 0, abstained: true, reason: 'no_classifier' });
    expect(called).toBe(false);
  });

  it('abstains when fetch throws (network/timeout)', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl });
    const v = await classify(A, B);
    expect(v.classification).toBe('uncertain');
    expect(v.abstained).toBe(true);
    expect(v.reason).toBe('classifier_error');
  });

  it('abstains on a non-ok response', async () => {
    const fetchImpl = (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl });
    expect((await classify(A, B)).classification).toBe('uncertain');
  });

  it('abstains on malformed (non-JSON) model output', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'I think they conflict.' }] }) }) as unknown as Response) as typeof fetch;
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl });
    expect((await classify(A, B)).classification).toBe('uncertain');
  });

  it('the returned promise never rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('any');
    }) as typeof fetch;
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl });
    await expect(classify(A, B)).resolves.toBeDefined();
  });
});

describe('makeHaikuClassifier — symmetrized two-pass', () => {
  it('both passes agree compatible → compatible', async () => {
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl: fakeFetch('compatible') });
    const v = await classify(A, B);
    expect(v.classification).toBe('compatible');
    expect(v.abstained).toBe(false);
    expect(v.confidence).toBeCloseTo(0.9);
  });

  it('both passes agree genuine_conflict → genuine_conflict', async () => {
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl: fakeFetch('genuine_conflict') });
    expect((await classify(A, B)).classification).toBe('genuine_conflict');
  });

  it('both passes agree replacement → replacement', async () => {
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl: fakeFetch('replacement') });
    expect((await classify(A, B)).classification).toBe('replacement');
  });

  it('passes disagree (compatible vs genuine_conflict) → uncertain', async () => {
    const classify = makeHaikuClassifier({ apiKey: 'k', fetchImpl: fakeFetchSequence(['compatible', 'genuine_conflict']) });
    const v = await classify(A, B);
    expect(v.classification).toBe('uncertain');
    expect(v.abstained).toBe(true);
    expect(v.reason).toBe('pass_disagreement');
  });
});

describe('parseLabel', () => {
  it('extracts a clean JSON object', () => {
    expect(parseLabel('{"label":"compatible","confidence":0.7}')).toEqual({ label: 'compatible', confidence: 0.7 });
  });
  it('tolerates surrounding prose', () => {
    expect(parseLabel('Here is my answer: {"label":"replacement","confidence":0.8} done')).toEqual({
      label: 'replacement',
      confidence: 0.8,
    });
  });
  it('clamps out-of-range confidence', () => {
    expect(parseLabel('{"label":"genuine_conflict","confidence":1.5}')).toEqual({ label: 'genuine_conflict', confidence: 1 });
  });
  it('rejects an unknown label', () => {
    expect(parseLabel('{"label":"banana","confidence":0.9}')).toBeNull();
  });
  it('returns null when no JSON present', () => {
    expect(parseLabel('they conflict')).toBeNull();
  });
});

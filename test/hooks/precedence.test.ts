import { describe, it, expect } from 'vitest';
import {
  composeBlockEnvelope,
  PURPOSE_STRING,
  PRECEDENCE_STRING,
  FOR_SESSION_TEMPLATE,
} from '../../src/hooks/precedence.js';

/**
 * Regression-protect the labeled-block content strings.
 * These are *content the model reads* — accidental edits change agent
 * behavior. Spec FR-002, FR-003 + research.md R-12.
 */
describe('hooks/precedence — verbatim content lock-in', () => {
  it('PURPOSE_STRING matches the v2 canonical text', () => {
    expect(PURPOSE_STRING).toBe(
      'authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions',
    );
  });

  it('PRECEDENCE_STRING enumerates all v2 multi-domain categories', () => {
    expect(PRECEDENCE_STRING).toBe(
      'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns',
    );
  });

  it('FOR_SESSION_TEMPLATE is a placeholder string', () => {
    expect(FOR_SESSION_TEMPLATE).toBe('<session_id>');
  });

  it('composeBlockEnvelope returns the canonical triple', () => {
    expect(composeBlockEnvelope()).toEqual({
      purpose: PURPOSE_STRING,
      precedence: PRECEDENCE_STRING,
      for_session_template: FOR_SESSION_TEMPLATE,
    });
  });
});

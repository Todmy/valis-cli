/**
 * Composer for the labeled-block `purpose` and `precedence` attributes.
 *
 * Per FR-002, FR-003 and data-model.md §1 (block_envelope). These strings
 * are *content the model reads* — keep verbatim and protect with a
 * regression test.
 */

import type { BlockEnvelope } from './cache.js';

export const PURPOSE_STRING =
  'authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions';

export const PRECEDENCE_STRING =
  'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns';

export const FOR_SESSION_TEMPLATE = '<session_id>';

export function composeBlockEnvelope(): BlockEnvelope {
  return {
    purpose: PURPOSE_STRING,
    precedence: PRECEDENCE_STRING,
    for_session_template: FOR_SESSION_TEMPLATE,
  };
}

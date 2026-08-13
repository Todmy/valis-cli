/**
 * gh#329 — `library_search` over the read-only `sources_v1` reference corpus.
 *
 * The governing rule of this suite: a broken library must never be reportable
 * as an empty result. Every failure path is asserted to carry a named code,
 * and the read-only boundary is asserted across the whole file.
 */

import { describe, it, expect } from 'vitest';
import { LibraryError } from '../../src/mcp/tools/library-search.js';

describe('LibraryError envelope', () => {
  it('carries the structured payload in the message', () => {
    const err = new LibraryError(
      'library_rebuild_required',
      'index:title',
      'The reference library needs reindexing.',
    );
    // The SDK keeps only `err.message` — it catches the throw and returns
    // createToolError(err.message) as a SUCCESSFUL result with isError:true
    // (server/mcp.js:140-158). So the message must BE the payload.
    expect(JSON.parse(err.message)).toEqual({
      error: {
        code: 'library_rebuild_required',
        missing: 'index:title',
        message: 'The reference library needs reindexing.',
      },
    });
  });

  it('exposes code and missing as instance properties', () => {
    // classifyError (analytics.ts:48-58) reads err.code off the instance.
    // A declared-but-unassigned field would emit error_code:'Error'.
    const err = new LibraryError('library_forbidden', 'project:abc', 'Not permitted.');
    expect(err.code).toBe('library_forbidden');
    expect(err.missing).toBe('project:abc');
    expect(err.name).toBe('LibraryError');
    expect(err).toBeInstanceOf(Error);
  });

  it('never produces a body containing a results key', () => {
    const err = new LibraryError('library_unavailable', 'query_failed', 'Upstream failed.');
    const body = JSON.parse(err.message) as Record<string, unknown>;
    expect(body).not.toHaveProperty('results');
  });
});

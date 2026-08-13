/**
 * gh#334 — coverage statement for a project's reference library.
 *
 * The tool description of `library_search` used to enumerate what the library
 * contains. That is only honest while exactly one library exists on the
 * deployment; once a library is an attachment of a project, a fixed sentence in
 * a shared tool description describes some other project's shelf. Coverage
 * therefore has to be answered per call, from the corpus itself.
 *
 * Read live via Qdrant's facet API over the scope filter — never from a
 * hand-maintained manifest, which is a second source of truth that goes stale
 * silently and would reintroduce the exact drift this replaces.
 */

import type { ServerConfig } from '../../types.js';
import {
  LibraryError,
  SOURCES_COLLECTION,
  assertLibrarySchema,
  buildScopeFilter,
  withLibrary,
  type QdrantLike,
} from './library-search.js';

/** Facet ceiling. A shelf longer than this is reported as truncated, not cut silently. */
const MAX_WORKS = 200;

export interface LibraryListArgs {
  /** Describe another project's library instead of the caller's own. */
  target_project_id?: string;
}

export interface LibraryWork {
  title: string;
  passages: number;
}

export interface LibraryListResult {
  project_id: string;
  /**
   * False when the project has no corpus attached. This is a legitimate answer,
   * not a fault: unlike a search, "what is on the shelf" is correctly answered
   * by "nothing". It is exactly what a caller needs before trusting an empty
   * `library_search` result.
   */
  has_library: boolean;
  total_passages: number;
  works: LibraryWork[];
  languages: string[];
  /** Set only when more distinct works exist than `works` could carry. */
  truncated?: true;
}

async function facetValues(
  client: QdrantLike,
  libraryProjectId: string,
  key: string,
  limit: number,
): Promise<Array<{ value: string; count: number }>> {
  const { hits } = await client.facet(SOURCES_COLLECTION, {
    key,
    filter: buildScopeFilter(libraryProjectId),
    limit,
    exact: true,
  });
  return (hits ?? [])
    .filter((h) => typeof h.value === 'string' && (h.value as string).trim() !== '')
    .map((h) => ({ value: h.value as string, count: h.count ?? 0 }));
}

/**
 * Describe the corpus attached to one project.
 *
 * The schema guard runs first for the same reason it does in `searchLibrary`: a
 * facet on an unindexed keyword field is an HTTP 400, and a coverage statement
 * that silently reported an empty shelf because an index was dropped would be
 * the same silent false absence in a new place.
 */
export async function listLibrary(
  client: QdrantLike,
  libraryProjectId: string,
): Promise<LibraryListResult> {
  assertLibrarySchema(
    (await client.getCollection(SOURCES_COLLECTION).catch(() => null)) as never,
  );

  const { count: total } = await client.count(SOURCES_COLLECTION, {
    filter: buildScopeFilter(libraryProjectId),
    exact: true,
  });

  if (total === 0) {
    return {
      project_id: libraryProjectId,
      has_library: false,
      total_passages: 0,
      works: [],
      languages: [],
    };
  }

  // One over the ceiling: the extra hit is how truncation is detected without
  // a second round trip, and it is dropped before the result is returned.
  const titles = await facetValues(client, libraryProjectId, 'title', MAX_WORKS + 1);
  const languages = await facetValues(client, libraryProjectId, 'lang', 50);

  const truncated = titles.length > MAX_WORKS;
  const works = titles
    .slice(0, MAX_WORKS)
    .map(({ value, count }) => ({ title: value, passages: count }))
    .sort((a, b) => b.passages - a.passages);

  if (works.length === 0) {
    // A populated scope whose points carry no usable `title` cannot be cited
    // from, so reporting it as a healthy-but-untitled shelf would promise
    // citations the corpus cannot honour.
    throw new LibraryError(
      'library_rebuild_required',
      'payload:title',
      'The reference library holds passages with no title; it needs reingesting.',
    );
  }

  return {
    project_id: libraryProjectId,
    has_library: true,
    total_passages: total,
    works,
    languages: languages.map((l) => l.value).sort(),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** MCP entry point for `library_list`. */
export async function handleLibraryList(
  args: LibraryListArgs,
  configOverride?: ServerConfig,
): Promise<LibraryListResult> {
  return withLibrary(args, configOverride, (client, libraryProjectId) =>
    listLibrary(client, libraryProjectId),
  );
}

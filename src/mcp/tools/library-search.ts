/**
 * gh#329 — read-only search over the reference library (`sources_v1`).
 *
 * The library is a corpus of externally authored engineering standards and
 * handbooks, indexed in its own Qdrant collection. It is deliberately NOT the
 * decision store: no source record takes part in lifecycle, outcomes,
 * contradiction detection, dedup, or synthesis. Physical collection
 * separation — not a payload discriminator — is what guarantees that, because
 * two org-wide consumers (`cleanup/dedup.ts:162`, `synthesis/cluster-registry.ts:292`)
 * take no scope parameter and would otherwise sweep the corpus in. See ADR 0004.
 *
 * The failure contract is the point of this module. An empty result read as
 * "the library holds no evidence" when the library is actually broken is the
 * failure mode the whole feature exists to prevent, so every fault path throws
 * a `LibraryError` with a named code rather than returning `[]`.
 */

export type LibraryErrorCode =
  | 'library_not_configured'
  | 'library_forbidden'
  | 'library_unavailable'
  | 'library_rebuild_required';

/**
 * Failure carrier whose `message` IS the structured payload.
 *
 * Verified against `@modelcontextprotocol/sdk@1.27.1`: the SDK catches any
 * exception a tool handler throws and returns `createToolError(err.message)` —
 * `{content:[{type:'text',text:message}], isError:true}`, a *successful*
 * JSON-RPC result, not a protocol error (`server/mcp.js:100,140-158`). Only
 * `err.message` survives; `code` and any custom property are discarded on the
 * wire. Serialising the payload into the message is what makes the failure
 * legible to the client, and it deliberately carries no `results` key so no
 * consumer can normalise it into an empty result with `results ?? []`.
 *
 * `code` and `missing` are still assigned on the instance because
 * `classifyError` (`analytics.ts:48-58`) reads `err.code` locally, before the
 * SDK ever sees the throw. Declaring them without assigning would emit
 * `error_code: 'Error'` into telemetry.
 */
export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly missing: string;

  constructor(code: LibraryErrorCode, missing: string, human: string) {
    super(JSON.stringify({ error: { code, missing, message: human } }));
    this.name = 'LibraryError';
    this.code = code;
    this.missing = missing;
  }
}

# valis

Team decision memory for AI coding agents. Your team's shared hippocampus -- every AI agent remembers what the team decided.

## Two ways to run Valis

| | **Hosted (recommended)** | **Community / self-host** |
|---|---|---|
| Status | ✅ Available today | ✅ Self-hostable (beta) |
| Backend | Managed cloud (`valis.krukit.co`) | Your own Supabase + Qdrant via Docker Compose |
| LLM keys | Server-side, nothing to configure | You supply your own |
| Setup | ~2 minutes | Run the full stack yourself |

If you are evaluating Valis today, **Hosted** is the fastest path. The self-host stack now runs from a clean `docker compose up` ([`community/`](./community)).

## Install

```bash
npm install -g valis-cli
```

**Requirements**: Node.js 20+

---

## Hosted (recommended)

Connect to the managed Valis cloud. No infrastructure, no API keys -- the backend and LLM keys live server-side.

```bash
valis init          # Create or join your team brain (~2 min)
valis serve         # Start the local MCP server (auto-configured by init)
```

Your AI agent (Claude Code, Codex, Cursor) now has team memory via MCP tools:

- `valis_store` -- capture decisions automatically
- `valis_search` -- recall past decisions
- `valis_context` -- load recent context at session start
- `valis_lifecycle` -- promote, deprecate, supersede decisions
- `valis_check_duplicate` -- check for similar existing decisions
- `valis_get_taxonomy_spec` -- query the data model

The Claude Code plugin path connects over HTTP MCP + OAuth, so the plugin handles auth for you. The CLI path stores a JWT in `~/.valis/config.json` after `valis login`.

---

## Community / self-host (beta)

> **Self-hostable (beta).** A clean `docker compose up` in [`community/`](./community) brings up the full backend. One known issue: a cosmetic Qdrant client/server version-skew warning on startup ([#300](https://github.com/Todmy/valis-cli/issues/300)) — harmless, the round-trip works.

Run everything yourself -- your own Supabase (Postgres, source of truth) and Qdrant (search) -- with your own LLM keys. The same `valis` binary runs in self-host mode; the difference is configuration only.

```bash
git clone https://github.com/Todmy/valis-cli && cd valis-cli/community
cp .env.example .env && ./generate-keys.sh && docker compose up -d
npm i -g valis-cli && valis init      # choose Community; leave QDRANT_API_KEY empty
```

See [`community/README.md`](./community/README.md) for the full walkthrough (ports, keys, CLI config). Self-host also uses:

- A local Supabase + Qdrant stack (Docker Compose).
- A local embedding model (no managed inference). See the caveat below.
- Optionally, your own LLM key for enrichment / contradiction classification.

### Local embeddings (fastembed)

Hosted uses Qdrant Cloud managed inference (`intfloat/multilingual-e5-small`, 384-dim). Self-host has no managed inference, so it generates dense vectors locally via the optional [`fastembed`](https://www.npmjs.com/package/fastembed) peer dependency:

```bash
npm install fastembed              # optional peer dependency
export QDRANT_EMBEDDING_STRATEGY=client
```

The client strategy uses fastembed's `all-MiniLM-L6-v2` (384-dim) -- the only fastembed model that matches the collection's 384-dim schema. (fastembed's multilingual `e5-large` is 1024-dim and would not fit the schema without a reindex.)

> ⚠️ **Caveat -- vectors are not interchangeable across modes.** The local fastembed model is **not** the same model as the hosted `e5-small`. A self-host instance must use **one consistent model** for both indexing and querying. Its own vectors stay internally coherent, but they cannot be mixed with vectors produced by the Hosted backend. Do not point a self-host instance at a collection that was indexed by Hosted (or vice versa) -- reindex from scratch with a single model.

### Routing the LLM through a gateway

Enrichment and contradiction classification call the Anthropic Messages API. Self-hosters routing through a gateway/proxy can override the base URL:

```bash
export ANTHROPIC_BASE_URL=https://your-gateway.example.com   # /v1/messages is appended
export ANTHROPIC_API_KEY=...                                 # absent => those features gracefully no-op
```

Defaults to `https://api.anthropic.com` when unset, so Hosted behaviour is unchanged.

---

## Commands

| Command | Description |
|---------|-------------|
| `valis init` | Create or join an organization |
| `valis login` | Authenticate with Valis Cloud |
| `valis serve` | Start MCP + Channel server |
| `valis status` | Show system health |
| `valis wake-up` | Show recent team activity |
| `valis search <query>` | Search decisions from terminal |
| `valis dashboard` | Show team activity stats |
| `valis enrich` | Classify decisions via LLM (optional) |
| `valis switch` | Switch org or project |
| `valis uninstall` | Clean removal |

## How It Works

1. **Init** -- registers your team brain, configures MCP, seeds from CLAUDE.md/DESIGN.md/git history
2. **Capture** -- AI agent calls `valis_store` when decisions are made
3. **Search** -- hybrid search (dense + BM25) with multi-signal reranking
4. **Push** -- real-time notifications to active team sessions

## Links

- [Documentation](https://github.com/Todmy/valis-cli#readme)
- [Issues](https://github.com/Todmy/valis-cli/issues)

## License

Apache-2.0

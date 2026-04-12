# valis

Team decision memory for AI coding agents. Your team's shared hippocampus -- every AI agent remembers what the team decided.

## Install

```bash
npm install -g valis-cli
```

**Requirements**: Node.js 20+

## Quick Start

```bash
valis init          # Create your team brain (30 seconds, no API keys)
valis serve         # Start MCP server (auto-configured by init)
```

Your AI agent (Claude Code, Codex, Cursor) now has team memory via MCP tools:

- `valis_store` -- capture decisions automatically
- `valis_search` -- recall past decisions
- `valis_context` -- load recent context at session start
- `valis_lifecycle` -- promote, deprecate, supersede decisions
- `valis_check_duplicate` -- check for similar existing decisions
- `valis_get_taxonomy_spec` -- query the data model

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

1. **Init** -- registers with Valis Cloud, configures MCP, seeds from CLAUDE.md/DESIGN.md/git history
2. **Capture** -- AI agent calls `valis_store` when decisions are made
3. **Search** -- hybrid search (dense + BM25) with multi-signal reranking
4. **Push** -- real-time notifications to active team sessions

## Links

- [Documentation](https://github.com/Todmy/valis)
- [Issues](https://github.com/Todmy/valis/issues)

## License

Apache-2.0

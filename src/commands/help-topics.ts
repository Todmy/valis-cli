/**
 * `valis help workflows` and `valis help mcp` — topic-style help for
 * multi-step recipes and the CLI ↔ MCP tool mapping.
 *
 * Per BACKLOG #149 (0.1.4 agent-friendliness package). Heavyweight
 * workflow DSLs are explicitly deferred per BACKLOG #150 — these are
 * plain markdown-flavored text that LLMs and humans both grok well.
 */

const WORKFLOWS_TEXT = `
VALIS — CANONICAL WORKFLOWS

Onboarding (first time on a fresh machine)
  1. valis init --template ts-saas      # seeds 18 starter decisions (or fintech / ai-agent)
                                        #   omit --template to start blank
  2. valis switch --project <name>      # bind cwd to a project (writes .valis.json)
  3. valis index ./docs                 # bulk-import existing markdown
  4. valis search "postgres"            # verify capture & retrieval

Capture loop (during a session)
  1. valis search "<topic>"             # check what's already decided
  2. /valis:store "<decision>"          # via plugin / agent — calls valis_store
  3. valis search "<topic>"             # verify the decision is queryable

Lifecycle curation (proposals queue)
  1. dashboard → Proposals tab          # see drafts
  2. promote / dismiss per proposal     # via UI or:
     valis_lifecycle({action: 'promote', decision_id: '<id>'})
     valis_lifecycle({action: 'deprecate', decision_id: '<id>'})

Pre-commit enforcement
  1. /valis:check  (or  valis-cli check-diff < <(git diff HEAD))
  2. Surface violations; let the agent fix or acknowledge with
     [valis-ack: <decision_id>] in the commit message.

CI enforcement (PR-time)
  1. Add Todmy/valis-action@v1 to .github/workflows/valis.yml
  2. Generate VALIS_TOKEN in dashboard → Settings → CI tokens
  3. Add VALIS_TOKEN to GitHub Actions secrets
  4. Push a PR; the action posts violation comments + fails on block-mode

Cross-project recall (when you remember it from another repo)
  1. valis search "<topic>" --all-projects
  2. valis switch --project <other-project>  # to capture follow-ups there
`;

const MCP_TEXT = `
VALIS — CLI ↔ MCP TOOL MAPPING

Every CLI command has a matching MCP tool. The CLI is a thin facade —
it loads config, resolves project from .valis.json, and forwards to the
same MCP handlers that any agent harness can call directly.

CLI command                     MCP tool                  Read-only?
─────────────────────────────────────────────────────────────────────
valis search                   valis_search              yes
valis index                    (CLI only — bulk wrapper)  no
                                  → calls valis_store per file
(implicit, agent-side)         valis_context             yes
(implicit, agent-side)         valis_check_duplicate     yes
(plugin: /valis:check)         valis_check_diff          yes (read-only check)
(no CLI)                       valis_lifecycle           no
(no CLI)                       valis_store               no
(no CLI)                       valis_create_project      no
(no CLI)                       valis_list_projects       yes
(no CLI)                       valis_get_taxonomy_spec   yes

How harnesses pick CLI vs MCP
  - For tools the agent calls many times per session: prefer MCP
    (one-time tool-list cost, no shell-spawn overhead).
  - For tools the user invokes interactively: prefer CLI (can be
    composed with other shell tools, doesn't pollute the agent's
    function-call budget).
  - For bulk operations: prefer CLI (e.g. valis index walks
    filesystem locally instead of streaming N files through MCP).

Plugin (Claude Code marketplace)
  Source: github.com/Todmy/valis-plugin
  Mode: HTTP MCP via OAuth 2.1
  Endpoint: https://valis.krukit.co/api/mcp
  Slash commands: /valis:init, /valis:store, /valis:search,
                  /valis:check, /valis:lifecycle, /valis:index, ...

Local stdio MCP (for non-Claude-Code agents)
  $ valis serve   # starts stdio MCP server on this terminal

Schema discovery
  $ valis schema --json | jq ".commands[] | .name"
  $ valis schema --json | jq ".mcp"
`;

export async function helpTopicCommand(topic: string): Promise<void> {
  switch (topic) {
    case 'workflows':
      console.log(WORKFLOWS_TEXT.trim());
      return;
    case 'mcp':
      console.log(MCP_TEXT.trim());
      return;
    default:
      console.error(`Unknown help topic: ${topic}`);
      console.error('Available topics: workflows, mcp');
      console.error('For per-command help, use: valis <command> --help');
      process.exit(1);
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleStore } from './tools/store.js';
import { handleSearch } from './tools/search.js';
import { handleContext } from './tools/context.js';
import { handleLifecycle } from './tools/lifecycle.js';
import { handleUpdateOutcome } from './tools/update-outcome.js';
import { handleEvolve } from './tools/evolve.js';
import { handleCheckDuplicate } from './tools/check-duplicate.js';
import { handleTaxonomy } from './tools/taxonomy.js';
import { handleListProjects } from './tools/list-projects.js';
import { handleCreateProject } from './tools/create-project.js';
import { handleCheckDiff } from './tools/check-diff.js';
import { proxyToolCall, ProxyError } from './proxy.js';
import { resolveMcpEndpoint } from '../cloud/api-url.js';
import { appendToQueue, flushQueue } from '../offline/queue.js';
import { VERSION } from '../index.js';
import type { ServerConfig, ValisConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Shared tool definitions — reused by both local and proxy servers
// ---------------------------------------------------------------------------

// 0.1.4: MCP tool annotations per spec 2025-03-26+. Per BACKLOG #149.
//
// Annotations are advisory hints for harnesses — agents can use them to
// gate destructive ops behind user confirmation, rank read-only tools
// for free use, etc. Per the MCP team's own guidance hints are NOT a
// security boundary, so the runtime behavior of the handlers is
// identical regardless of annotation. They make sense as discovery
// metadata only.

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

const TOOL_DEFS = {
  valis_store: {
    description:
      'Store a team decision, constraint, pattern, or lesson into the shared team brain. Call this whenever an important technical decision is made. Use status: "proposed" for decisions that need team review before becoming active.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Store a team decision',
    } as ToolAnnotations,
    schema: {
      text: z.string().min(10).describe('Full decision text (min 10 chars)'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).optional().describe('Decision classification'),
      summary: z.string().max(100).optional().describe('Brief summary (max 100 chars)'),
      affects: z.array(z.string()).optional().describe("Affected areas, e.g. ['auth', 'payments']"),
      // 0.1.6 / BUG #152: aligned to Postgres CHECK constraint
       // (decisions.confidence REAL 0.0..1.0, set in migration 011). The 1..10
      // INTEGER range was the original migration 001 shape; 011 relaxed it to
      // float and the schema here was never updated. Every cross-harness
      // agent that respected the published JSON Schema and sent an integer was
      // failing the call with `decisions_confidence_check`. Float matches.
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Confidence score 0.0–1.0 (0=uncertain, 1=high)'),
      project_id: z.string().optional().describe('Project directory name'),
      session_id: z.string().optional().describe('Session UUID for dedup'),
      status: z.enum(['active', 'proposed']).optional().describe("Initial status — 'proposed' for team review, defaults to 'active'"),
      replaces: z.string().uuid().optional().describe('UUID of decision being replaced (target transitions to superseded)'),
      depends_on: z.array(z.string().uuid()).optional().describe('UUIDs of dependency decisions'),
    },
  },
  valis_search: {
    description:
      "Search the team's shared decision history. Use before making decisions to check what the team already decided. Results are scoped to the active project by default. Set all_projects to search across all accessible projects.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      title: 'Search team decisions',
    } as ToolAnnotations,
    schema: {
      query: z.string().min(1).describe('Search query text'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).optional().describe('Filter by type'),
      limit: z.number().int().min(1).max(50).default(10).optional().describe('Max results'),
      all_projects: z.boolean().optional().describe('Search across all accessible projects instead of just the active one'),
      // 0.1.7-dev / BUG #161: control how much of each matched decision is
      // returned. Default ('siblings') gives the matched chunk plus ±1
      // adjacent chunks for context — best balance of relevance vs token
      // budget. 'chunk' returns just the matched window. 'full' returns
      // the whole decision body (expensive for long docs; opt-in when the
      // agent knows it needs the complete document).
      expand: z
        .enum(['chunk', 'siblings', 'full'])
        .optional()
        .describe(
          "Return granularity. 'siblings' (default): matched chunk + ±1 context. 'chunk': matched chunk only. 'full': whole decision body (expensive for long docs).",
        ),
      // 032/Track 6 — structured filter dimensions
      status: z.enum(['active', 'proposed', 'deprecated', 'superseded']).optional().describe('Filter by lifecycle status'),
      min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence (0.0-1.0)'),
      max_confidence: z.number().min(0).max(1).optional().describe('Maximum confidence (0.0-1.0)'),
      created_after: z.string().optional().describe('ISO date — only decisions created on or after this date'),
      created_before: z.string().optional().describe('ISO date — only decisions created on or before this date'),
      author: z.string().optional().describe('Filter by author name'),
      affects: z.array(z.string()).optional().describe('Filter by areas (match.any — at least one tag matches)'),
      pinned: z.boolean().optional().describe('Filter by pinned status'),
      source: z.enum(['mcp_store', 'file_watcher', 'stop_hook', 'seed']).optional().describe('Filter by capture source'),
      outcome: z.enum(['success', 'failed', 'partial', 'unknown']).optional().describe('Filter by after-the-fact outcome verdict'),
      query_mode: z.enum(['semantic', 'metadata_only']).optional().describe("'semantic' (default): hybrid vector+BM25 search. 'metadata_only': bypass embedding, scan payload only — fast for list queries with no semantic intent."),
      // 031/Track 5b — edge walking
      depth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().describe('Walk decision_edges up to N levels deep from each hit (0=identity, 1=immediate neighbours, 2=neighbours-of-neighbours)'),
      mode: z.enum(['summary', 'full']).optional().describe("Payload shape for `related` neighbours. 'summary' (default): {decision_id, summary, edge_type, depth, reason}. 'full': include full decision body."),
      edge_types: z.array(z.enum(['supersedes', 'builds_on', 'synthesizes', 'contradicts'])).optional().describe('Optional edge-type filter for the walk'),
    },
  },
  valis_context: {
    description:
      'Load relevant team decisions for the current task. Call at the start of every new task or when switching codebases. Results are scoped to the active project by default.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      title: 'Load task-relevant team context',
    } as ToolAnnotations,
    schema: {
      task_description: z.string().min(1).describe('What you are working on'),
      files: z.array(z.string()).optional().describe('File paths being worked on'),
      all_projects: z.boolean().optional().describe('Load context from all accessible projects'),
    },
  },
  valis_lifecycle: {
    description:
      'Manage decision lifecycle: deprecate outdated decisions, promote proposed ones to active, pin/unpin decisions, or view status change history.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Change decision lifecycle status',
    } as ToolAnnotations,
    schema: {
      action: z.enum(['deprecate', 'promote', 'history', 'pin', 'unpin']).describe('Lifecycle action to perform'),
      decision_id: z.string().describe('UUID of the target decision'),
      reason: z.string().optional().describe('Reason for the status change'),
    },
  },
  valis_update_outcome: {
    description:
      "Record the after-the-fact outcome of a decision (success | failed | partial | unknown). Use weeks or months after a decision was taken when real-world evidence arrives. Outcome string is typo-tolerant — 'SUCCEEDED', 'OK', 'BROKE', 'regression' all normalise to the four canonical values. Search automatically deprioritises 'failed'-outcome decisions unless the query explicitly asks about failures.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Update decision outcome',
    } as ToolAnnotations,
    schema: {
      decision_id: z.string().uuid().describe('UUID of the decision to update'),
      outcome: z
        .string()
        .min(1)
        .describe(
          "Outcome — canonical 'success' | 'failed' | 'partial' | 'unknown'. Aliases like 'SUCCEEDED', 'OK', 'BROKE', 'regression' are accepted and normalised.",
        ),
      reason: z
        .string()
        .optional()
        .describe('Optional plain-text reason for the outcome verdict'),
    },
  },
  valis_evolve: {
    description:
      "Declare an explicit typed relationship between two decisions ('supersedes', 'builds_on', 'synthesizes', or 'contradicts'). Use when the team revises, builds on, fuses, or contradicts a prior decision. Both decisions must exist in the caller's org; the edge becomes walkable via `valis_search(..., depth: 1|2)`.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Link two decisions with a typed edge',
    } as ToolAnnotations,
    schema: {
      from_id: z.string().uuid().describe('UUID of the source decision (the predecessor or related-from)'),
      to_id: z.string().uuid().describe('UUID of the target decision (the newer or related-to)'),
      type: z
        .enum(['supersedes', 'builds_on', 'synthesizes', 'contradicts'])
        .describe('Relationship type — see tool description for semantics'),
      reason: z
        .string()
        .optional()
        .describe('Optional plain-text reason explaining why the edge exists'),
    },
  },
  valis_check_duplicate: {
    description:
      'Check for similar existing decisions before storing a new one. Returns semantically similar matches above a threshold. Informational only — never blocks storage.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      title: 'Find similar existing decisions',
    } as ToolAnnotations,
    schema: {
      text: z.string().min(1).describe('Decision text to check for duplicates'),
      threshold: z.number().min(0).max(1).optional().describe('Similarity threshold 0.0-1.0 (default 0.85)'),
    },
  },
  valis_get_taxonomy_spec: {
    description:
      'Get the Valis taxonomy specification — data types, statuses, naming conventions, and tool usage guidance.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
      title: 'Get taxonomy specification',
    } as ToolAnnotations,
    schema: {},
  },
  valis_list_projects: {
    description:
      'List every project the authenticated member has access to, with role and decision count. Use this before /valis:init or when the user asks which projects they can connect to.',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      title: 'List accessible projects',
    } as ToolAnnotations,
    schema: {},
  },
  valis_create_project: {
    description:
      "Create a new project in the authenticated member's org and assign them as project_admin. Use when the user wants to connect a repo to a project that doesn't exist yet (e.g. during /valis:init after they chose 'create new'). Optionally seed it from a constitution template ('ts-saas', 'fintech', 'ai-agent') — fintech requires the 'pro' plan or higher.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Create a new project',
    } as ToolAnnotations,
    schema: {
      project_name: z.string().min(1).max(100).describe('Name of the new project (1-100 chars)'),
      org_id: z.string().uuid().optional().describe("Org UUID — defaults to the authenticated member's org"),
      enforcement_mode: z
        .enum(['block', 'suggest'])
        .optional()
        .describe(
          "Enforcement mode for the new project. Defaults to 'block'. The legacy 'warn' value is rejected per 019/US3.",
        ),
      template_id: z
        .enum(['ts-saas', 'fintech', 'ai-agent'])
        .optional()
        .describe(
          "Optional constitution template to seed the project with. Templates are version-pinned; the seeded `template_source` records '<id>@v<version>'. Plan-locked: 'fintech' requires 'pro' or higher.",
        ),
    },
  },
  valis_check_diff: {
    description:
      'Run the same enforcement check that the GitHub Action runs at PR time, but against an unstaged or staged unified diff. Use BEFORE committing to surface decision violations early. Pair with /valis:check, which captures `git diff HEAD` and forwards it here.',
    schema: {
      diff: z.string().min(1).describe('Unified-diff text (output of `git diff` or equivalent)'),
      project_id: z.string().uuid().optional().describe('Optional project UUID — resolved from session context if absent'),
      metadata: z.object({
        actor: z.string().optional().describe('Free-text actor label (e.g. "alice in IDE")'),
        commit_sha: z.string().optional().describe('Optional — if the diff is against a specific commit'),
      }).optional().describe('Optional metadata. `pr_url` is intentionally not accepted — its presence would re-classify the check as PR-time.'),
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Shared prompt definitions — reused by both local and proxy servers
// ---------------------------------------------------------------------------

interface PromptDef {
  name: string;
  description: string;
  args?: Record<string, z.ZodType>;
  build: (args: Record<string, string>) => {
    messages: { role: 'user'; content: { type: 'text'; text: string } }[];
  };
}

const PROMPT_DEFS: PromptDef[] = [
  {
    name: 'search',
    description: 'Search the team knowledge base for past decisions',
    args: { query: z.string().describe('What to search for') },
    build: (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Search the team knowledge base using valis_search for: ${args.query}\n\nSummarize what you find. Group results by type (decisions, constraints, patterns, lessons). Highlight any deprecated or superseded items and explain what replaced them.`,
        },
      }],
    }),
  },
  {
    name: 'store',
    description: 'Record a team decision, constraint, pattern, or lesson',
    args: {
      text: z.string().describe('What was decided and why'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).describe('Classification'),
    },
    build: (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Store this ${args.type} in the team knowledge base using valis_store:\n\n${args.text}\n\nAfter storing, confirm what was saved: show the ID, summary, type, and any contradiction warnings.`,
        },
      }],
    }),
  },
  {
    name: 'before_task',
    description: 'Load context and constraints before starting a task',
    args: { task: z.string().describe('What you are about to work on') },
    build: (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I'm about to work on: ${args.task}\n\nUse valis_context to load relevant team decisions for this task. Then:\n1. List active constraints that apply to this area\n2. List patterns I should follow\n3. Flag any potential conflicts between existing decisions and this task\n4. Give me a short checklist of things to keep in mind before starting`,
        },
      }],
    }),
  },
  {
    name: 'capture_discussion',
    description: 'Extract and store decisions from meeting notes',
    args: { notes: z.string().describe('Meeting notes or discussion text') },
    build: (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Here are notes from a team discussion:\n\n${args.notes}\n\nExtract each distinct technical decision, constraint, or pattern from these notes. For each one:\n1. Store it using valis_store with the appropriate type (decision, constraint, pattern, or lesson)\n2. Add a clear summary (max 100 chars)\n3. Tag affected areas in the "affects" field\n4. Use status "proposed" if the decision needs further team review\n\nAfter storing all items, show a summary table: ID, type, summary, status.`,
        },
      }],
    }),
  },
  {
    name: 'architecture_check',
    description: 'Verify a planned change against existing team constraints',
    args: { plan: z.string().describe('Description of the planned change') },
    build: (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I'm planning the following change:\n\n${args.plan}\n\nUse valis_search to find all active constraints and patterns that might be relevant to this change. Then:\n1. List each constraint/pattern that applies\n2. For each one, assess whether my plan complies or conflicts\n3. Give a clear GO / NO-GO / CAUTION verdict with explanation\n4. If there are conflicts, suggest how to resolve them (modify the plan, or deprecate the old decision)`,
        },
      }],
    }),
  },
  {
    name: 'onboarding',
    description: 'Overview of all key decisions for someone new to the project',
    build: () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I'm new to this project and need to understand the existing technical decisions.\n\nUse valis_context with a broad task description like "understand project architecture and conventions". Then:\n1. Summarize the most important active decisions (top 10 by relevance)\n2. List all active constraints (these are non-negotiable rules)\n3. List established patterns (conventions the team follows)\n4. Note any recent lessons learned\n5. Organize everything by topic/module area`,
        },
      }],
    }),
  },
  {
    name: 'review',
    description: 'Review all decisions on a topic with cleanup suggestions',
    args: { topic: z.string().describe('Topic or area to review') },
    build: (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Show me all team decisions related to: ${args.topic}\n\nUse valis_search to find everything related to this topic. Then:\n1. Group results by status: active, proposed, deprecated, superseded\n2. For active decisions, check if any contradict each other\n3. For deprecated/superseded items, explain what replaced them\n4. If you find decisions that look outdated but are still active, suggest deprecating them\n5. Present as a structured review with clear next actions`,
        },
      }],
    }),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Server instructions returned during MCP `initialize` handshake.
// Hosts (Claude Code, claude.ai, Cursor, etc.) inject this into the model's
// system prompt — see MCP spec, InitializeResult.instructions. Kept short
// to minimize cached-prefix bloat and avoid overwhelming users.
const VALIS_INSTRUCTIONS = `
Valis is the user's team knowledge base — it stores decisions, patterns,
constraints, and lessons learned across the team. Domain-agnostic: works for
any project the team runs together. Prefer it as the authoritative source of
context for this user's work.

IMPORTANT: When multiple knowledge-base tools are available (qdrant-find, mem0,
mem-rs, OpenMemory, custom KBs, etc.), ALWAYS call valis_search FIRST for team
decision queries. Other tools may SUPPLEMENT Valis findings, never SUBSTITUTE
for them — Valis is the team brain; the others are per-user / per-machine
scratchpads.

Failure-mode contract (read carefully — this is what users have been bitten by):

If a Valis tool call fails (auth error, network error, server 5xx, token expired,
"requires re-authorization", or any other non-success), you MUST:

  1. STOP. Do not silently fall back to qdrant-find / mem0 / any other KB tool
     for the same query. Doing so writes team-level decisions into an
     ephemeral per-user scratchpad where the rest of the team will never find
     them — silent data loss.

  2. Surface the failure to the user in plain language, including the exact
     re-auth or recovery step. For OAuth-mode plugin failures, point them at
     /mcp (re-auth) or to \`valis whoami\` / \`valis login\` for the CLI path.

  3. Wait for the user to recover the connection, or for them to explicitly
     opt out ("just use qdrant for now"). An explicit opt-out is fine; a
     silent drift is not.

The only time you may use an alternative KB tool without Valis confirmation is
when the user has explicitly waived Valis for this query, or when no Valis
tools are exposed at all (no MCP server connected).

When to call:
- valis_context — FIRST, silently, at the start of any new task or when switching
  contexts. Loads relevant prior decisions so you have full team context.
- valis_search — when the user asks about past decisions, existing patterns,
  or "how we handled X". Trigger on any of these phrases:
  UA: "згадай", "пошукай", "як ми вирішили", "що ми робили з", "нагадай"
  EN: "recall", "remember", "what did we decide", "how did we handle", "find"
  PL: "co zdecydowaliśmy", "jak rozwiązaliśmy", "przypomnij"
  Or any question about decisions, conventions, or existing patterns.
- valis_store — after a choice is made between alternatives, a constraint is
  identified, a pattern is established, or a lesson is learned from an
  outcome. Always include type (decision|constraint|pattern|lesson) and a
  short summary.
- valis_check_duplicate — before storing, check for similar existing decisions
  to avoid redundancy. Informational only, never blocks.
- valis_get_taxonomy_spec — when you need to understand Valis data types,
  statuses, or naming conventions.

Insight capture:
After completing a meaningful task, briefly explain the non-obvious "why"
behind your choices — trade-offs, gotchas, or reusable patterns. Then call
valis_store with the appropriate type and a concise summary so the team
retains this knowledge.

Pre-compaction capture (v0.5.2):
When the user runs /compact, Claude Code's PreCompact hook BLOCKS the
compaction with a structured "capture required" message until decisions
from this conversation are stored. If you receive such a block:
  1. Walk the conversation already in your context. For each decision /
     constraint / pattern / lesson, call valis_store.
  2. After all valis_store calls, run via the Bash tool:
        valis hook capture-done --stored <N>
     This creates the local sentinel that gates the next /compact.
  3. Invoke /compact again via the SlashCommand tool.
If no decisions were made this session, still run step 2 with
"--stored 0 --note 'no decisions'" so /compact can proceed.
`.trim();

function createBaseServer(): McpServer {
  return new McpServer(
    { name: 'valis', version: VERSION },
    {
      capabilities: {
        tools: {},
        prompts: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: VALIS_INSTRUCTIONS,
    },
  );
}

/**
 * 0.1.4: helper that wires a tool definition (description + schema +
 * annotations) into the new `server.registerTool` API. Replaces the
 * deprecated `server.tool(name, desc, schema, cb)` overload and ensures
 * annotations actually reach `tools/list` responses (where harnesses
 * read them for capability inference).
 */
function registerToolFromDef<Name extends keyof typeof TOOL_DEFS>(
  server: McpServer,
  name: Name,
  cb: (args: never) => Promise<{ content: { type: 'text'; text: string }[] }>,
): void {
  const def = TOOL_DEFS[name];
  const config: {
    title?: string;
    description: string;
    inputSchema: unknown;
    annotations?: ToolAnnotations;
  } = {
    title: (def as { annotations?: ToolAnnotations }).annotations?.title,
    description: def.description,
    inputSchema: def.schema,
    annotations: (def as { annotations?: ToolAnnotations }).annotations,
  };
  // Cast through unknown to avoid the SDK's tight Zod-shape coupling here;
  // each call site below passes a typed handler that matches its def.
  (server.registerTool as unknown as (n: string, c: typeof config, h: typeof cb) => void)(
    name,
    config,
    cb,
  );
}

function registerPrompts(server: McpServer): void {
  for (const p of PROMPT_DEFS) {
    if (p.args) {
      server.prompt(p.name, p.description, p.args, p.build);
    } else {
      server.prompt(p.name, p.description, p.build as () => ReturnType<PromptDef['build']>);
    }
  }
}

// ---------------------------------------------------------------------------
// Local MCP server — handles tools in-process
// ---------------------------------------------------------------------------

export function createMcpServer(configOverride?: ServerConfig): McpServer {
  const server = createBaseServer();

  // 0.1.4: registerToolFromDef wires description + schema + annotations
  // through the new server.registerTool API so harnesses see the
  // readOnlyHint/destructiveHint/idempotentHint annotations on tools/list.
  registerToolFromDef(server, 'valis_store', async (args) => {
    const result = await handleStore(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_search', async (args) => {
    const result = await handleSearch(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_context', async (args) => {
    const result = await handleContext(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_lifecycle', async (args) => {
    const result = await handleLifecycle(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_update_outcome', async (args) => {
    const result = await handleUpdateOutcome(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_evolve', async (args) => {
    const result = await handleEvolve(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_check_duplicate', async (args) => {
    const result = await handleCheckDuplicate(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_get_taxonomy_spec', async () => {
    const result = await handleTaxonomy({});
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_list_projects', async () => {
    const result = await handleListProjects(configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  registerToolFromDef(server, 'valis_create_project', async (args) => {
    const result = await handleCreateProject(args as never, configOverride);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  // 019/US2: check_diff returns pre-formatted human-readable content blocks
  // instead of JSON. Forward as-is (the helper's stringify-wrapping path is
  // wrong for this one tool).
  registerToolFromDef(server, 'valis_check_diff', async (args) => {
    const result = await handleCheckDiff(args as never, configOverride);
    return result as { content: { type: 'text'; text: string }[] };
  });

  registerPrompts(server);
  return server;
}

// ---------------------------------------------------------------------------
// Proxy MCP server — forwards every tool call to the remote endpoint
// ---------------------------------------------------------------------------

export function createProxyMcpServer(config: ValisConfig): McpServer {
  const endpoint = resolveMcpEndpoint(config);
  const token = config.member_api_key ?? config.api_key;

  const server = createBaseServer();

  for (const [toolName, def] of Object.entries(TOOL_DEFS)) {
    server.tool(
      toolName,
      def.description,
      def.schema,
      async (args: Record<string, unknown>) => {
        try {
          const content = await proxyToolCall(endpoint, token, toolName, args);
          return { content: content as Array<{ type: 'text'; text: string }> };
        } catch (err) {
          // T007: Offline fallback for store calls
          if (toolName === 'valis_store' && args.text && !(err instanceof ProxyError && err.statusCode === 401)) {
            const id = await appendToQueue(
              { text: args.text as string, type: args.type as 'decision' | 'constraint' | 'pattern' | 'lesson' | undefined, summary: args.summary as string | undefined, affects: args.affects as string[] | undefined },
              config.author_name,
              'mcp_store',
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify({ id, status: 'stored', synced: false, note: 'offline — queued locally' }) }] };
          }
          // Non-store tools or auth errors: propagate
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
        }
      },
    );
  }

  // valis_sync — proxy-mode only, flushes offline queue on demand
  server.tool(
    'valis_sync',
    'Sync offline-queued decisions to the cloud. Use when decisions were stored while offline and you want to push them now.',
    {},
    async () => {
      const result = await flushQueue(endpoint, token);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  registerPrompts(server);
  return server;
}

// ---------------------------------------------------------------------------
// Stdio entry point
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Valis MCP server running (stdio)');
}

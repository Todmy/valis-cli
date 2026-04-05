import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleStore } from './tools/store.js';
import { handleSearch } from './tools/search.js';
import { handleContext } from './tools/context.js';
import { handleLifecycle } from './tools/lifecycle.js';
import type { ServerConfig } from '../types.js';

export function createMcpServer(configOverride?: ServerConfig): McpServer {
  const server = new McpServer(
    {
      name: 'valis',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        experimental: { 'claude/channel': {} },
      },
    },
  );

  // valis_store
  server.tool(
    'valis_store',
    'Store a team decision, constraint, pattern, or lesson into the shared team brain. Call this whenever an important technical decision is made. Use status: "proposed" for decisions that need team review before becoming active.',
    {
      text: z.string().min(10).describe('Full decision text (min 10 chars)'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).optional().describe('Decision classification'),
      summary: z.string().max(100).optional().describe('Brief summary (max 100 chars)'),
      affects: z.array(z.string()).optional().describe("Affected areas, e.g. ['auth', 'payments']"),
      confidence: z.number().int().min(1).max(10).optional().describe('Confidence score 1-10'),
      project_id: z.string().optional().describe('Project directory name'),
      session_id: z.string().optional().describe('Session UUID for dedup'),
      status: z.enum(['active', 'proposed']).optional().describe("Initial status — 'proposed' for team review, defaults to 'active'"),
      replaces: z.string().uuid().optional().describe('UUID of decision being replaced (target transitions to superseded)'),
      depends_on: z.array(z.string().uuid()).optional().describe('UUIDs of dependency decisions'),
    },
    async (args) => {
      const result = await handleStore(args, configOverride);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // valis_search — T024: add all_projects parameter for cross-project search
  server.tool(
    'valis_search',
    "Search the team's shared decision history. Use before making architectural decisions to check what the team already decided. Results are scoped to the active project by default. Set all_projects to search across all accessible projects.",
    {
      query: z.string().min(1).describe('Search query text'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).optional().describe('Filter by type'),
      limit: z.number().int().min(1).max(50).default(10).optional().describe('Max results'),
      all_projects: z.boolean().optional().describe('Search across all accessible projects instead of just the active one'),
    },
    async (args) => {
      const result = await handleSearch(args, configOverride);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // valis_context — T024: add all_projects parameter for cross-project context
  server.tool(
    'valis_context',
    'Load relevant team decisions for the current task. Call at the start of every new task or when switching codebases. Results are scoped to the active project by default.',
    {
      task_description: z.string().min(1).describe('What you are working on'),
      files: z.array(z.string()).optional().describe('File paths being worked on'),
      all_projects: z.boolean().optional().describe('Load context from all accessible projects'),
    },
    async (args) => {
      const result = await handleContext(args, configOverride);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // valis_lifecycle
  server.tool(
    'valis_lifecycle',
    'Manage decision lifecycle: deprecate outdated decisions, promote proposed ones to active, pin/unpin decisions, or view status change history.',
    {
      action: z.enum(['deprecate', 'promote', 'history', 'pin', 'unpin']).describe('Lifecycle action to perform'),
      decision_id: z.string().describe('UUID of the target decision'),
      reason: z.string().optional().describe('Reason for the status change'),
    },
    async (args) => {
      const result = await handleLifecycle(args, configOverride);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- Prompts ---

  // Basic: search
  server.prompt(
    'search',
    'Search the team knowledge base for past decisions',
    { query: z.string().describe('What to search for') },
    (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Search the team knowledge base using valis_search for: ${args.query}\n\nSummarize what you find. Group results by type (decisions, constraints, patterns, lessons). Highlight any deprecated or superseded items and explain what replaced them.`,
        },
      }],
    }),
  );

  // Basic: store
  server.prompt(
    'store',
    'Record a team decision, constraint, pattern, or lesson',
    {
      text: z.string().describe('What was decided and why'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).describe('Classification'),
    },
    (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Store this ${args.type} in the team knowledge base using valis_store:\n\n${args.text}\n\nAfter storing, confirm what was saved: show the ID, summary, type, and any contradiction warnings.`,
        },
      }],
    }),
  );

  // Workflow: before_task
  server.prompt(
    'before_task',
    'Load context and constraints before starting a task',
    { task: z.string().describe('What you are about to work on') },
    (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I'm about to work on: ${args.task}\n\nUse valis_context to load relevant team decisions for this task. Then:\n1. List active constraints that apply to this area\n2. List patterns I should follow\n3. Flag any potential conflicts between existing decisions and this task\n4. Give me a short checklist of things to keep in mind before starting`,
        },
      }],
    }),
  );

  // Workflow: capture_discussion
  server.prompt(
    'capture_discussion',
    'Extract and store decisions from meeting notes',
    { notes: z.string().describe('Meeting notes or discussion text') },
    (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Here are notes from a team discussion:\n\n${args.notes}\n\nExtract each distinct technical decision, constraint, or pattern from these notes. For each one:\n1. Store it using valis_store with the appropriate type (decision, constraint, pattern, or lesson)\n2. Add a clear summary (max 100 chars)\n3. Tag affected areas in the "affects" field\n4. Use status "proposed" if the decision needs further team review\n\nAfter storing all items, show a summary table: ID, type, summary, status.`,
        },
      }],
    }),
  );

  // Workflow: architecture_check
  server.prompt(
    'architecture_check',
    'Verify a planned change against existing team constraints',
    { plan: z.string().describe('Description of the planned change') },
    (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I'm planning the following change:\n\n${args.plan}\n\nUse valis_search to find all active constraints and patterns that might be relevant to this change. Then:\n1. List each constraint/pattern that applies\n2. For each one, assess whether my plan complies or conflicts\n3. Give a clear GO / NO-GO / CAUTION verdict with explanation\n4. If there are conflicts, suggest how to resolve them (modify the plan, or deprecate the old decision)`,
        },
      }],
    }),
  );

  // Workflow: onboarding
  server.prompt(
    'onboarding',
    'Overview of all key decisions for someone new to the project',
    () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I'm new to this project and need to understand the existing technical decisions.\n\nUse valis_context with a broad task description like "understand project architecture and conventions" and set all_projects to true. Then:\n1. Summarize the most important active decisions (top 10 by relevance)\n2. List all active constraints (these are non-negotiable rules)\n3. List established patterns (conventions the team follows)\n4. Note any recent lessons learned\n5. Organize everything by topic/module area`,
        },
      }],
    }),
  );

  // Workflow: review
  server.prompt(
    'review',
    'Review all decisions on a topic with cleanup suggestions',
    { topic: z.string().describe('Topic or area to review') },
    (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Show me all team decisions related to: ${args.topic}\n\nUse valis_search to find everything related to this topic. Then:\n1. Group results by status: active, proposed, deprecated, superseded\n2. For active decisions, check if any contradict each other\n3. For deprecated/superseded items, explain what replaced them\n4. If you find decisions that look outdated but are still active, suggest deprecating them\n5. Present as a structured review with clear next actions`,
        },
      }],
    }),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Valis MCP server running (stdio)');
}

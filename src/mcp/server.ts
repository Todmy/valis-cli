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

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Valis MCP server running (stdio)');
}

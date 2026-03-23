import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleStore } from './tools/store.js';
import { handleSearch } from './tools/search.js';
import { handleContext } from './tools/context.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'teamind',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
    },
  );

  // teamind_store
  server.tool(
    'teamind_store',
    'Store a team decision, constraint, pattern, or lesson into the shared team brain. Call this whenever an important technical decision is made.',
    {
      text: z.string().min(10).describe('Full decision text (min 10 chars)'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).optional().describe('Decision classification'),
      summary: z.string().max(100).optional().describe('Brief summary (max 100 chars)'),
      affects: z.array(z.string()).optional().describe("Affected areas, e.g. ['auth', 'payments']"),
      confidence: z.number().int().min(1).max(10).optional().describe('Confidence score 1-10'),
      project_id: z.string().optional().describe('Project directory name'),
      session_id: z.string().optional().describe('Session UUID for dedup'),
    },
    async (args) => {
      const result = await handleStore(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // teamind_search
  server.tool(
    'teamind_search',
    "Search the team's shared decision history. Use before making architectural decisions to check what the team already decided.",
    {
      query: z.string().min(1).describe('Search query text'),
      type: z.enum(['decision', 'constraint', 'pattern', 'lesson']).optional().describe('Filter by type'),
      limit: z.number().int().min(1).max(50).default(10).optional().describe('Max results'),
    },
    async (args) => {
      const result = await handleSearch(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // teamind_context
  server.tool(
    'teamind_context',
    'Load relevant team decisions for the current task. Call at the start of every new task or when switching codebases.',
    {
      task_description: z.string().min(1).describe('What you are working on'),
      files: z.array(z.string()).optional().describe('File paths being worked on'),
    },
    async (args) => {
      const result = await handleContext(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Teamind MCP server running (stdio)');
}

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';
import { loadCredentials, isLoggedIn } from '../config/credentials.js';
import { HOSTED_API_URL, HOSTED_SUPABASE_URL } from '../types.js';

// ---------------------------------------------------------------------------
// Skill suggestion heuristics — maps area clusters to skill archetypes
// ---------------------------------------------------------------------------

const SKILL_ARCHETYPES: Array<{
  keywords: string[];
  name: string;
  description: string;
  steps: string[];
}> = [
  {
    keywords: ['copywriting', 'copy', 'brand', 'messaging', 'tone', 'landing', 'headline', 'cta', 'email'],
    name: 'copywriter',
    description: 'Write copy using team brand decisions, tone guidelines, and messaging patterns',
    steps: [
      'Call valis_search for brand decisions, tone, messaging constraints',
      'Review existing copy patterns and what worked before',
      'Write the copy following team guidelines: $ARGUMENTS',
      'Call valis_store if a new messaging pattern or brand decision emerges',
    ],
  },
  {
    keywords: ['marketing', 'growth', 'acquisition', 'funnel', 'conversion', 'launch', 'channel', 'seo'],
    name: 'marketer',
    description: 'Plan marketing strategies grounded in team growth decisions and channel data',
    steps: [
      'Call valis_search for growth strategy, channel decisions, past campaign learnings',
      'Analyze what channels and tactics the team has already validated',
      'Create a plan for: $ARGUMENTS',
      'Call valis_store for new strategy decisions or channel learnings',
    ],
  },
  {
    keywords: ['architecture', 'infrastructure', 'database', 'api', 'backend', 'deployment', 'devops', 'system'],
    name: 'architect',
    description: 'Make architecture decisions informed by existing team patterns and constraints',
    steps: [
      'Call valis_search for architecture decisions, infrastructure constraints, patterns',
      'Review dependencies and existing system boundaries',
      'Analyze and propose: $ARGUMENTS',
      'Call valis_store for any new architecture decisions made',
    ],
  },
  {
    keywords: ['product', 'feature', 'roadmap', 'prioritization', 'user', 'persona', 'metric', 'kpi'],
    name: 'product-manager',
    description: 'Make product decisions using team strategy, user research, and past learnings',
    steps: [
      'Call valis_search for product strategy, user research, prioritization decisions',
      'Check for related constraints and open contradictions',
      'Analyze and recommend: $ARGUMENTS',
      'Call valis_store for product decisions and trade-off rationales',
    ],
  },
  {
    keywords: ['research', 'analysis', 'competitive', 'market', 'benchmark', 'data', 'report'],
    name: 'researcher',
    description: 'Research topics using web search and team knowledge, store findings',
    steps: [
      'Call valis_search to check what the team already knows',
      'Use WebSearch and WebFetch to gather current information',
      'Compare new findings with existing team decisions',
      'Call valis_store for each new insight (type: lesson or decision)',
      'Summarize: what was found, what\'s new, what was stored',
    ],
  },
  {
    keywords: ['security', 'auth', 'encryption', 'compliance', 'audit', 'vulnerability', 'access'],
    name: 'security-advisor',
    description: 'Review security posture against team security decisions and constraints',
    steps: [
      'Call valis_search for security constraints, auth decisions, compliance requirements',
      'Audit the relevant area: $ARGUMENTS',
      'Cross-reference with known patterns and past security lessons',
      'Call valis_store for new security findings or constraint updates',
    ],
  },
  {
    keywords: ['testing', 'qa', 'test', 'coverage', 'e2e', 'integration', 'unit'],
    name: 'qa-advisor',
    description: 'Plan and review testing strategies based on team testing decisions',
    steps: [
      'Call valis_search for testing patterns, coverage decisions, CI constraints',
      'Review current test coverage and gaps for: $ARGUMENTS',
      'Recommend testing approach aligned with team conventions',
      'Call valis_store for new testing decisions or patterns discovered',
    ],
  },
];

// ---------------------------------------------------------------------------
// Project analysis — reads decisions and suggests skills
// ---------------------------------------------------------------------------

interface ProjectInfo {
  id: string;
  name: string;
  role: string;
}

async function listProjects(memberApiKey: string): Promise<ProjectInfo[]> {
  try {
    const tokenRes = await fetch(`${HOSTED_API_URL}/api/exchange-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${memberApiKey}`,
      },
    });
    if (!tokenRes.ok) return [];
    const { token: jwt } = (await tokenRes.json()) as { token: string };

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(HOSTED_SUPABASE_URL, 'placeholder', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: memberships } = await supabase
      .from('project_members')
      .select('project_id, role, projects(id, name)');

    if (!memberships) return [];

    return memberships
      .map((pm) => {
        const project = pm.projects as unknown as { id: string; name: string } | null;
        return project ? { id: project.id, name: project.name, role: pm.role as string } : null;
      })
      .filter((p): p is ProjectInfo => p !== null);
  } catch {
    return [];
  }
}

async function analyzeProjectAreas(
  memberApiKey: string,
  projectId: string,
): Promise<string[]> {
  try {
    const tokenRes = await fetch(`${HOSTED_API_URL}/api/exchange-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${memberApiKey}`,
      },
      body: JSON.stringify({ project_id: projectId }),
    });
    if (!tokenRes.ok) return [];
    const { token: jwt } = (await tokenRes.json()) as { token: string };

    const searchRes = await fetch(`${HOSTED_API_URL}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ query: '*', limit: 30, project_id: projectId }),
    });
    if (!searchRes.ok) return [];

    const data = (await searchRes.json()) as {
      results: Array<{ affects?: string[]; type?: string; detail?: string }>;
    };

    // Count area frequencies
    const areaCounts: Record<string, number> = {};
    for (const r of data.results) {
      if (r.affects) {
        for (const area of r.affects) {
          areaCounts[area] = (areaCounts[area] || 0) + 1;
        }
      }
      // Also extract keywords from detail text
      if (r.detail) {
        const lower = r.detail.toLowerCase();
        for (const archetype of SKILL_ARCHETYPES) {
          for (const kw of archetype.keywords) {
            if (lower.includes(kw)) {
              areaCounts[kw] = (areaCounts[kw] || 0) + 1;
            }
          }
        }
      }
    }

    return Object.entries(areaCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([area]) => area);
  } catch {
    return [];
  }
}

function suggestSkills(areas: string[]): typeof SKILL_ARCHETYPES {
  const scored = SKILL_ARCHETYPES.map((archetype) => {
    let score = 0;
    for (const kw of archetype.keywords) {
      if (areas.includes(kw)) score++;
    }
    return { archetype, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.archetype);
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function addCommandCommand(name?: string): Promise<void> {
  // 1. Scope: global or local
  const scope = await select({
    message: 'Where should this command be available?',
    choices: [
      { name: 'Global (all projects)', value: 'global' as const },
      { name: 'This project only', value: 'local' as const },
    ],
  });

  // 2. Connect to a project for context
  let selectedProject: ProjectInfo | null = null;
  let suggestedSkills: typeof SKILL_ARCHETYPES = [];

  if (await isLoggedIn()) {
    const creds = await loadCredentials();
    if (creds) {
      console.log(pc.cyan('\nLoading projects...'));
      const projects = await listProjects(creds.member_api_key);

      if (projects.length > 0) {
        const projectId = await select({
          message: 'Which project should this command use for context?',
          choices: projects.map((p) => ({
            name: `${p.name} (${p.role})`,
            value: p.id,
          })),
        });

        selectedProject = projects.find((p) => p.id === projectId) || null;

        // Analyze project data and suggest skills
        console.log(pc.dim(`  Analyzing ${selectedProject?.name} decisions...`));
        const areas = await analyzeProjectAreas(creds.member_api_key, projectId);

        if (areas.length > 0) {
          suggestedSkills = suggestSkills(areas);
          console.log(pc.dim(`  Top areas: ${areas.slice(0, 5).join(', ')}`));
        }
      } else {
        console.log(pc.yellow('  No projects found. Create one first: valis init'));
        return;
      }
    }
  }

  // 3. Command name — suggest from analysis or ask user
  let commandName: string;

  if (!name && suggestedSkills.length > 0) {
    const projLabel = selectedProject ? ` (${selectedProject.name})` : '';
    const choices = [
      ...suggestedSkills.slice(0, 5).map((s) => ({
        name: `${s.name}${projLabel} — ${s.description}`,
        value: s.name,
      })),
      { name: 'Custom name...', value: '__custom__' },
    ];

    const picked = await select({
      message: `Suggested skills for ${selectedProject?.name || 'project'}:`,
      choices,
    });

    commandName = picked === '__custom__'
      ? await input({ message: 'Command name (without valis- prefix):' })
      : picked;
  } else {
    commandName = name || await input({ message: 'Command name (without valis- prefix):' });
  }

  const fullName = `valis-${commandName}`;
  const filename = `${fullName}.md`;

  // 4. Determine output directory
  const dir = scope === 'global'
    ? join(homedir(), '.claude', 'commands')
    : join(process.cwd(), '.claude', 'commands');

  const filePath = join(dir, filename);

  if (existsSync(filePath)) {
    console.log(pc.yellow(`Command /${fullName} already exists at ${filePath}`));
    return;
  }

  // 5. Generate template — use archetype if matched, otherwise generic
  const matchedArchetype = SKILL_ARCHETYPES.find((a) => a.name === commandName);

  let description: string;
  let steps: string[];

  if (matchedArchetype) {
    description = matchedArchetype.description;
    steps = matchedArchetype.steps;
  } else {
    description = await input({
      message: 'What does this command do?',
      default: `Custom Valis command: ${commandName}`,
    });
    steps = [
      'Call valis_search to check relevant team decisions',
      '$ARGUMENTS',
      'Call valis_store if new decisions or lessons emerge',
    ];
  }

  // Add project context to template if connected
  const projectLine = selectedProject
    ? `\n## Context\nConnected to project: ${selectedProject.name}\n`
    : '';

  const template = `---
description: ${description}
---
${projectLine}
## Task
$ARGUMENTS

## Steps
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`;

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, template);

  console.log(pc.green(`\n✓ Created /${fullName}`));
  console.log(pc.dim(`  ${filePath}`));
  if (matchedArchetype) {
    console.log(pc.dim(`  Pre-configured with ${commandName} workflow. Edit to customize.`));
  } else {
    console.log(pc.dim(`  Edit the file to customize the command behavior.`));
  }
}

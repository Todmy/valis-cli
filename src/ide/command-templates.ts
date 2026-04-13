export const COMMAND_TEMPLATES: Record<string, string> = {
  'valis-research': `---
description: Research a topic using web search and store findings as team decisions in Valis
---

## Task
Research "$ARGUMENTS" using web search and team context.

## Steps
1. Call valis_search to check what the team already knows about this topic
2. Use WebSearch and WebFetch to gather current information
3. Synthesize findings — compare with existing team decisions
4. Call valis_store for each new insight with appropriate type (decision|lesson|pattern|constraint)
5. Summarize: what was found, what's new vs what we already knew, what was stored
`,

  'valis-review': `---
description: Review code changes against team decisions, patterns, and constraints stored in Valis
---

## Task
Review current code changes against team conventions.

## Steps
1. Run \`git diff --cached\` (or \`git diff\` if nothing staged) to see changes
2. Identify affected areas from the diff (e.g., auth, database, api-design)
3. Call valis_search for each affected area to load relevant decisions and constraints
4. For each relevant decision/constraint, check if the diff aligns or conflicts
5. Report:
   - Aligned: changes that follow team decisions
   - Conflicts: changes that violate constraints or contradict decisions
   - Missing: decisions that should exist but don't (suggest valis_store)
`,

  'valis-recall': `---
description: Deep search across all Valis projects for team decisions, patterns, and lessons
---

## Task
Find everything the team knows about "$ARGUMENTS".

## Steps
1. Call valis_search with the query
2. Call valis_search with related terms and synonyms
3. If results span multiple areas, group by area
4. For each result, show: status, type, summary, when it was made
5. Highlight any contradictions or deprecated decisions that might be relevant
6. If nothing found, suggest what the team should document about this topic
`,
};

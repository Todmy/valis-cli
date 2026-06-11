/**
 * 045 Find Gaps — curated archetype contract (FR-030).
 *
 * The 6 curated archetypes ship as version-pinned JSON assets in `./archetypes/`.
 * They are statically imported (NodeNext JSON import attributes + tsconfig
 * `resolveJsonModule`, same pattern as `templates/index.ts`) so tsc emits them
 * into `dist/` and there is no runtime fs read in either the dev (vitest/src) or
 * production (web/dist) path.
 *
 * `loadCuratedArchetypes()` validates every file through `ArchetypeSchema` and
 * THROWS on the first invalid one — FR-030 mandates fail-at-load, never silent
 * runtime degradation. A schema test (`schema.test.ts`) exercises this on all 6
 * shipped files plus rejection fixtures.
 */

import { z } from 'zod';
import type { Archetype } from './llm.js';

import eCommerce from './archetypes/e-commerce.json' with { type: 'json' };
import b2bSaasCrud from './archetypes/b2b-saas-crud.json' with { type: 'json' };
import marketplace from './archetypes/marketplace.json' with { type: 'json' };
import authIdentity from './archetypes/auth-identity.json' with { type: 'json' };
import billingSubscriptions from './archetypes/billing-subscriptions.json' with { type: 'json' };
import complianceDataPrivacy from './archetypes/compliance-data-privacy.json' with { type: 'json' };

export const ArchetypeComponentSchema = z.object({
  component: z.string().min(1),
  importance: z.number().int().min(1).max(5),
  commonly_forgotten: z.boolean(),
  conditional_on: z.string().min(1).optional(),
  platform_provided_by: z.array(z.string().min(1)).min(1).optional(),
});

export const ArchetypeSchema = z.object({
  domain: z.string().min(1),
  version: z.string().min(1),
  components: z.array(ArchetypeComponentSchema).min(1),
});

/** The raw, unvalidated curated assets. Order is irrelevant — keyed by domain on load. */
const CURATED_FILES: ReadonlyArray<{ name: string; raw: unknown }> = [
  { name: 'e-commerce.json', raw: eCommerce },
  { name: 'b2b-saas-crud.json', raw: b2bSaasCrud },
  { name: 'marketplace.json', raw: marketplace },
  { name: 'auth-identity.json', raw: authIdentity },
  { name: 'billing-subscriptions.json', raw: billingSubscriptions },
  { name: 'compliance-data-privacy.json', raw: complianceDataPrivacy },
];

/**
 * Validate and index the 6 curated archetypes by `domain`. Throws (FR-030) on
 * the first file that fails schema validation, naming the file and the zod
 * issue so a malformed asset surfaces at startup/test time, never at runtime.
 */
export function loadCuratedArchetypes(): Map<string, Archetype> {
  const byDomain = new Map<string, Archetype>();
  for (const { name, raw } of CURATED_FILES) {
    const parsed = ArchetypeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid curated archetype "${name}": ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    if (byDomain.has(parsed.data.domain)) {
      throw new Error(`Duplicate curated archetype domain "${parsed.data.domain}" (${name})`);
    }
    byDomain.set(parsed.data.domain, parsed.data);
  }
  return byDomain;
}

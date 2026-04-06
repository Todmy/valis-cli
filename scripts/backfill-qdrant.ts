#!/usr/bin/env tsx
/**
 * One-time backfill: reads all decisions from Supabase and upserts them
 * into the Qdrant `decisions` collection.
 *
 * Usage: npx dotenv -e ../web/.env.local -- npx tsx scripts/backfill-qdrant.ts
 */

import { createClient } from '@supabase/supabase-js';
import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION = 'decisions';
const VECTOR_SIZE = 384;

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const qdrantUrl = process.env.QDRANT_URL!;
const qdrantApiKey = process.env.QDRANT_API_KEY!;

if (!supabaseUrl || !supabaseKey || !qdrantUrl) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or QDRANT_URL');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });

interface Decision {
  id: string;
  org_id: string;
  project_id: string | null;
  type: string;
  summary: string | null;
  text: string;
  author: string;
  affects: string[];
  confidence: number | null;
  status: string;
  replaces: string | null;
  depends_on: string[] | null;
  created_at: string;
}

async function main() {
  // 1. Fetch all decisions from Supabase
  const { data: decisions, error } = await supabase
    .from('decisions')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch decisions:', error.message);
    process.exit(1);
  }

  console.log(`Found ${decisions.length} decisions in Supabase`);

  // 2. Check current Qdrant count
  const countResult = await qdrant.count(COLLECTION, { exact: true });
  console.log(`Current Qdrant points: ${countResult.count}`);

  // 3. Upsert in batches of 10
  const BATCH_SIZE = 10;
  let upserted = 0;

  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE) as Decision[];
    const points = batch.map((d) => {
      const payload: Record<string, unknown> = {
        org_id: d.org_id,
        type: d.type || 'pending',
        summary: d.summary || null,
        detail: d.text,
        author: d.author,
        affects: d.affects || [],
        confidence: d.confidence || null,
        pinned: false,
        replaces: d.replaces || null,
        depends_on: d.depends_on || [],
        status: d.status || 'active',
        created_at: d.created_at,
      };
      if (d.project_id) {
        payload.project_id = d.project_id;
      }
      return {
        id: d.id,
        payload,
        vector: new Array(VECTOR_SIZE).fill(0),
      };
    });

    await qdrant.upsert(COLLECTION, { points });
    upserted += points.length;
    console.log(`  Upserted ${upserted}/${decisions.length}`);
  }

  // 4. Verify
  const finalCount = await qdrant.count(COLLECTION, { exact: true });
  console.log(`\nDone. Qdrant points: ${finalCount.count}`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});

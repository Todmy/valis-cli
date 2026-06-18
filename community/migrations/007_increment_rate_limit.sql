-- 007: Atomic rate limit increment function
-- Fixes bug where upsert was overwriting counts instead of incrementing

CREATE OR REPLACE FUNCTION increment_rate_limit(p_org_id UUID, p_day DATE, p_operation TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO rate_limits (org_id, day, store_count, search_count)
  VALUES (p_org_id, p_day,
    CASE WHEN p_operation = 'store' THEN 1 ELSE 0 END,
    CASE WHEN p_operation = 'search' THEN 1 ELSE 0 END)
  ON CONFLICT (org_id, day) DO UPDATE SET
    store_count = CASE WHEN p_operation = 'store' THEN rate_limits.store_count + 1 ELSE rate_limits.store_count END,
    search_count = CASE WHEN p_operation = 'search' THEN rate_limits.search_count + 1 ELSE rate_limits.search_count END;
END;
$$ LANGUAGE plpgsql;

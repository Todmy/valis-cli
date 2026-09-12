-- Harden the Data API surface for gap tables: members may read their project
-- data, while all writes remain behind authenticated service-side routes.
REVOKE INSERT, UPDATE, DELETE ON public.gap_runs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.gap_questions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.gap_events FROM authenticated;

GRANT SELECT ON public.gap_runs, public.gap_questions, public.gap_events TO authenticated;

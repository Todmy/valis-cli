-- Keep the community schema aligned with the hosted Data API grants.
REVOKE INSERT, UPDATE, DELETE ON public.gap_runs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.gap_questions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.gap_events FROM authenticated;

GRANT SELECT ON public.gap_runs, public.gap_questions, public.gap_events TO authenticated;

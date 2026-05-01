-- =============================================================
-- MIGRATION 006 — PER-DIVE SYNCHRO DETECTION FOR TEAM EVENTS
--
-- Real FINA Team Event format mixes individual and synchronised
-- dives inside a single event. The schema already supports this:
-- a dive list row with `partner_id` set is a synchro dive, and
-- one without is individual.
--
-- This migration extends `calc_event_dive_points` so it picks
-- the right scoring rule per dive:
--
--   - event_type = 'synchro_pair'         → role-grouped synchro
--                                            (judges 1-3 exec A,
--                                             4-6 exec B, 7-11 sync)
--   - event_type = 'team' AND has_partner → individual trim × 0.6
--     (synchro dive within a mixed event scored on the team's
--      panel — no role grouping because team panels are smaller)
--   - otherwise                            → individual trim × DD
--
-- The new `has_partner` argument has a default of false so every
-- existing caller continues to work without change.
-- =============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.calc_event_dive_points(integer[], numeric[], integer, numeric, event_type);

CREATE OR REPLACE FUNCTION public.calc_event_dive_points(
    judge_numbers integer[],
    scores        numeric[],
    num_judges    integer,
    dd            numeric,
    e_type        event_type,
    has_partner   boolean DEFAULT false
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF e_type = 'synchro_pair' THEN
        RETURN public.calc_synchro_dive_points(judge_numbers, scores, num_judges, dd);
    ELSIF has_partner THEN
        -- Synchro dive inside a team event: use the team's
        -- individual-style trim, then apply the 0.6 normalising
        -- factor so its magnitude lines up with non-synchro
        -- team dives.
        RETURN public.calc_dive_points(scores, num_judges, dd) * 0.6;
    ELSE
        RETURN public.calc_dive_points(scores, num_judges, dd);
    END IF;
END
$$;

COMMIT;

-- =============================================================
-- MIGRATION 004 — EVENT TYPES + SYNCHRONISED SCORING
--
-- Adds three things:
--
--   1. An `event_type` enum so events can be flagged as
--      individual, synchronised pair, or (future) team. Every
--      existing event becomes 'individual'.
--
--   2. A nullable `partner_id` on competitor_dive_lists. For
--      synchro events, each pair has dive list rows with the
--      "primary" diver in competitor_id and the partner in
--      partner_id.
--
--   3. A `calc_synchro_dive_points()` function that applies the
--      correct World Aquatics rule for synchronised diving:
--
--        9-judge panel — j1+j2 score Diver A execution,
--          j3+j4 score Diver B execution, j5..j9 score sync.
--          Award = (j1 + j2 + j3 + j4 + middle 3 of j5..j9) × DD × 0.6
--
--       11-judge panel — j1..j3 score Diver A exec (middle 1
--          counted), j4..j6 score Diver B exec (middle 1
--          counted), j7..j11 score sync (middle 3 counted).
--          Award = (mid_A + mid_B + sum middle 3 sync) × DD × 0.6
--
--      Both formulas multiply by 0.6 to normalise to "3
--      effective scores" so synchro dive points are comparable
--      to individual dive points.
--
-- Run:
--   psql -d your_db_name -f migrations/004_event_types_and_synchro.sql
--
-- Idempotent.
-- =============================================================

BEGIN;

DO $$ BEGIN
    CREATE TYPE event_type AS ENUM ('individual', 'synchro_pair', 'team');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS event_type event_type DEFAULT 'individual' NOT NULL;

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_dive_lists_partner ON public.competitor_dive_lists (partner_id);

-- =============================================================
-- World Aquatics synchronised scoring
-- =============================================================
CREATE OR REPLACE FUNCTION public.calc_synchro_dive_points(
    judge_numbers integer[],
    scores        numeric[],
    num_judges    integer,
    dd            numeric
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    n           integer;
    exec_a      numeric[];
    exec_b      numeric[];
    sync_grp    numeric[];
    sorted      numeric[];
    counted_sum numeric := 0;
    mid         numeric;
BEGIN
    IF scores IS NULL OR array_length(scores, 1) IS NULL THEN
        RETURN 0;
    END IF;

    -- Bucket judges by position into the three groups defined by
    -- the panel size. We pair (judge_number, score) by index.
    exec_a := ARRAY[]::numeric[];
    exec_b := ARRAY[]::numeric[];
    sync_grp := ARRAY[]::numeric[];

    FOR n IN 1 .. array_length(scores, 1) LOOP
        IF num_judges = 9 THEN
            IF judge_numbers[n] BETWEEN 1 AND 2 THEN
                exec_a := exec_a || scores[n];
            ELSIF judge_numbers[n] BETWEEN 3 AND 4 THEN
                exec_b := exec_b || scores[n];
            ELSIF judge_numbers[n] BETWEEN 5 AND 9 THEN
                sync_grp := sync_grp || scores[n];
            END IF;
        ELSIF num_judges = 11 THEN
            IF judge_numbers[n] BETWEEN 1 AND 3 THEN
                exec_a := exec_a || scores[n];
            ELSIF judge_numbers[n] BETWEEN 4 AND 6 THEN
                exec_b := exec_b || scores[n];
            ELSIF judge_numbers[n] BETWEEN 7 AND 11 THEN
                sync_grp := sync_grp || scores[n];
            END IF;
        ELSE
            -- Unsupported synchro panel size — fall back to
            -- summing every score. Won't normalise correctly but
            -- avoids returning zero on misconfigured events.
            sync_grp := sync_grp || scores[n];
        END IF;
    END LOOP;

    -- Execution group A: 9-judge keeps both, 11-judge keeps middle 1
    IF array_length(exec_a, 1) IS NOT NULL THEN
        IF num_judges = 9 THEN
            SELECT SUM(s) INTO counted_sum
            FROM unnest(exec_a) AS s;
        ELSIF num_judges = 11 AND array_length(exec_a, 1) = 3 THEN
            SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(exec_a) AS s;
            counted_sum := counted_sum + sorted[2];
        ELSE
            -- Defensive: any other size, just sum
            SELECT SUM(s) + counted_sum INTO counted_sum FROM unnest(exec_a) AS s;
        END IF;
    END IF;

    -- Execution group B
    IF array_length(exec_b, 1) IS NOT NULL THEN
        IF num_judges = 9 THEN
            SELECT counted_sum + SUM(s) INTO counted_sum
            FROM unnest(exec_b) AS s;
        ELSIF num_judges = 11 AND array_length(exec_b, 1) = 3 THEN
            SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(exec_b) AS s;
            counted_sum := counted_sum + sorted[2];
        ELSE
            SELECT counted_sum + SUM(s) INTO counted_sum FROM unnest(exec_b) AS s;
        END IF;
    END IF;

    -- Synchronisation group: 5 judges, drop high+low, keep middle 3
    IF array_length(sync_grp, 1) IS NOT NULL THEN
        IF array_length(sync_grp, 1) = 5 THEN
            SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(sync_grp) AS s;
            counted_sum := counted_sum + sorted[2] + sorted[3] + sorted[4];
        ELSE
            -- Partial / malformed sync group — sum what's there
            SELECT counted_sum + SUM(s) INTO counted_sum FROM unnest(sync_grp) AS s;
        END IF;
    END IF;

    -- World Aquatics synchro multiplies by DD and a normalising
    -- factor of 0.6 (= 3 / 5) so totals are comparable to
    -- individual dive points.
    RETURN counted_sum * COALESCE(dd, 1.0) * 0.6;
END
$$;

COMMENT ON FUNCTION public.calc_synchro_dive_points(integer[], numeric[], integer, numeric) IS
'Returns synchronised diving points for one dive: groups judges by position into Diver A execution / Diver B execution / synchronisation, applies the correct World Aquatics drops per group, sums, multiplies by DD × 0.6.';

-- Single dispatch wrapper so every standings / leaderboard /
-- archive / PDF query can compute dive points without caring
-- whether the event is individual or synchronised.
CREATE OR REPLACE FUNCTION public.calc_event_dive_points(
    judge_numbers integer[],
    scores        numeric[],
    num_judges    integer,
    dd            numeric,
    e_type        event_type
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF e_type = 'synchro_pair' THEN
        RETURN public.calc_synchro_dive_points(judge_numbers, scores, num_judges, dd);
    ELSE
        RETURN public.calc_dive_points(scores, num_judges, dd);
    END IF;
END
$$;

COMMIT;

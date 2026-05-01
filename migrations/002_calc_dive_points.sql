-- =============================================================
-- MIGRATION 002 — DIVE POINTS PER WORLD AQUATICS RULES
--
-- Adds a database function that turns a panel of per-judge
-- scores into the official dive points value.
--
-- Trim rules (individual events):
--    3 judges      drop none, keep 3
--    5 judges      drop high + low, keep middle 3
--    7 judges      drop 2 high + 2 low, keep middle 3
--    9 judges      drop 2 high + 2 low, keep middle 5  (× 3/5 to normalise)
--   11 judges      drop 3 high + 3 low, keep middle 5  (× 3/5 to normalise)
--
--   dive_points = (sum of counted scores) × DD × scaling
--
-- Scaling is 1.0 for 3-, 5- and 7-judge panels (which already
-- count 3 scores) and 0.6 for 9- and 11-judge panels (which
-- count 5), so dive points are comparable across panel sizes.
--
-- Run:
--   psql -d your_db_name -f migrations/002_calc_dive_points.sql
--
-- Idempotent — uses CREATE OR REPLACE.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.calc_dive_points(
    scores      numeric[],
    num_judges  integer,
    dd          numeric
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    sorted       numeric[];
    n            integer;
    drop_count   integer;
    scaling      numeric;
    counted_sum  numeric;
BEGIN
    IF scores IS NULL OR array_length(scores, 1) IS NULL THEN
        RETURN 0;
    END IF;

    -- Sort ascending so the dropped ends are at known positions.
    SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(scores) AS s;
    n := array_length(sorted, 1);

    drop_count := CASE
        WHEN num_judges = 5  THEN 1
        WHEN num_judges = 7  THEN 2
        WHEN num_judges = 9  THEN 2
        WHEN num_judges = 11 THEN 3
        ELSE 0
    END;

    scaling := CASE
        WHEN num_judges IN (9, 11) THEN 0.6   -- 5 counted scores normalised to 3
        ELSE 1.0
    END;

    -- Apply trim only when we actually have a full panel's worth
    -- of scores. If a dive is partially scored (live edge case)
    -- we skip the trim and just sum what we have, so the partial
    -- value still moves in roughly the right direction.
    IF drop_count > 0 AND n > drop_count * 2 THEN
        SELECT SUM(s) INTO counted_sum
        FROM unnest(sorted[(drop_count + 1) : (n - drop_count)]) AS s;
    ELSE
        SELECT SUM(s) INTO counted_sum FROM unnest(sorted) AS s;
    END IF;

    RETURN COALESCE(counted_sum, 0) * COALESCE(dd, 1.0) * scaling;
END
$$;

COMMENT ON FUNCTION public.calc_dive_points(numeric[], integer, numeric) IS
'Returns the official dive points for a panel of judge scores under World Aquatics individual-event rules: drop high/low per panel size, sum counted scores, multiply by DD, normalise 9/11-judge panels by 0.6 so totals are comparable across panel sizes.';

COMMIT;

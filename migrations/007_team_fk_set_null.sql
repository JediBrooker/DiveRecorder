-- =============================================================
-- MIGRATION 007 — TEAM DELETION PRESERVES DIVE HISTORY
--
-- The original 005 migration declared
-- competitor_dive_lists.team_id with ON DELETE CASCADE, which
-- meant deleting a team would wipe every dive list row that ever
-- pointed at it (and cascade onwards into scores via the existing
-- (event_id, competitor_id, round_number) FK on scores).
--
-- That's destructive for historical data: an admin renaming or
-- pruning teams should keep the meet results intact and just
-- sever the team attribution.
--
-- This migration switches that FK to ON DELETE SET NULL. Now
-- deleting a team leaves the dive list rows in place with
-- team_id = NULL — the standings query just stops grouping
-- those rows under the deleted team's name. team_members and
-- event_teams stay ON DELETE CASCADE (those are pure links
-- whose deletion is intentional).
--
-- Run:
--   psql -d your_db_name -f migrations/007_team_fk_set_null.sql
--
-- Idempotent.
-- =============================================================

BEGIN;

ALTER TABLE public.competitor_dive_lists
    DROP CONSTRAINT IF EXISTS competitor_dive_lists_team_id_fkey;

ALTER TABLE public.competitor_dive_lists
    ADD CONSTRAINT competitor_dive_lists_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

COMMIT;

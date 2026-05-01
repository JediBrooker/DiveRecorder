-- =============================================================
-- MIGRATION 005 — TEAM EVENTS
--
-- Adds the schema needed for `event_type = 'team'` events:
--
--   1. `teams` — a named group of divers (e.g. "USA Diving").
--      Each team belongs to one organisation.
--
--   2. `team_members` — many-to-many between teams and users so
--      a diver can belong to several teams over time.
--
--   3. `event_teams` — which teams are entered in which event.
--
--   4. `competitor_dive_lists.team_id` — when a dive list row is
--      part of a team event, this points at the team. Standings
--      queries aggregate by team_id for team events; for
--      individual / synchro events team_id is NULL and scoring
--      stays per-competitor.
--
-- Run:
--   psql -d your_db_name -f migrations/005_teams.sql
--
-- Idempotent.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.teams (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    short_code  varchar(20),
    created_at  timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON public.teams (org_id);

CREATE TABLE IF NOT EXISTS public.team_members (
    team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    added_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members (user_id);

CREATE TABLE IF NOT EXISTS public.event_teams (
    event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    added_at   timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (event_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_event_teams_team ON public.event_teams (team_id);

ALTER TABLE public.competitor_dive_lists
    ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_dive_lists_team ON public.competitor_dive_lists (team_id);

COMMIT;

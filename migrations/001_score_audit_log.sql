-- =============================================================
-- MIGRATION 001 — SCORE AUDIT LOG
-- Adds an append-only log of every score insert/update/delete
-- so disputes can be resolved with a complete record of who
-- submitted what, from where, and when.
--
-- Run against an existing database:
--     psql -d your_db -f migrations/001_score_audit_log.sql
--
-- Idempotent — safe to run more than once.
-- =============================================================

BEGIN;

-- These two columns are referenced by server.js but were missing
-- from the original schema_v2.sql. They're added here defensively
-- so a clean install ends up consistent with what the server
-- expects. Safe to run on a DB that already has them.
ALTER TABLE public.event_judges
    ADD COLUMN IF NOT EXISTS judge_number integer;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS email varchar(255);

-- The set of mutations we track. We never hard-delete from this
-- table — even row deletes leave a trail.
DO $$ BEGIN
    CREATE TYPE score_audit_action AS ENUM ('insert', 'update', 'delete');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.score_audit_log (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    score_id        uuid,                                            -- nullable after delete
    event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    judge_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    round_number    integer NOT NULL,
    action          score_audit_action NOT NULL,
    old_score       numeric(3,1),                                    -- null for insert
    new_score       numeric(3,1),                                    -- null for delete
    actor_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    ip_address      inet,
    user_agent      text,
    created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_score_audit_event_round ON public.score_audit_log (event_id, round_number);
CREATE INDEX IF NOT EXISTS idx_score_audit_event_created ON public.score_audit_log (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_audit_competitor ON public.score_audit_log (competitor_id);
CREATE INDEX IF NOT EXISTS idx_score_audit_judge ON public.score_audit_log (judge_id);

COMMIT;

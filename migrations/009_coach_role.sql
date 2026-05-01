-- =============================================================
-- MIGRATION 009 — COACH ROLE
--
-- Adds 'coach' to the org_role enum and the coach_diver_links
-- table for explicit coach → diver associations. A coach can
-- have many divers; a diver may have multiple coaches over
-- time. The link table stores the assignment plus an
-- audit-friendly created_at timestamp.
--
-- Migration is idempotent — uses ADD VALUE IF NOT EXISTS for
-- the enum, CREATE TABLE IF NOT EXISTS for the link table.
--
-- Run:
--   psql -d your_db_name -f migrations/009_coach_role.sql
-- =============================================================

BEGIN;

-- 1. Extend the org_role enum. Postgres doesn't allow ALTER
--    TYPE … ADD VALUE inside a transaction in older versions,
--    but it's permitted from PG 12+ (which the README requires).
ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'coach';

-- 2. Coach ↔ Diver links. Both reference users.id and cascade
--    on deletion of either side. UNIQUE prevents duplicate
--    assignments and gives an implicit "is this user my coach"
--    index.
CREATE TABLE IF NOT EXISTS public.coach_diver_links (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    coach_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    diver_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    note        text,
    created_at  timestamptz DEFAULT now() NOT NULL,
    UNIQUE (coach_id, diver_id),
    CONSTRAINT coach_diver_distinct CHECK (coach_id <> diver_id)
);

CREATE INDEX IF NOT EXISTS idx_coach_diver_coach ON public.coach_diver_links (coach_id);
CREATE INDEX IF NOT EXISTS idx_coach_diver_diver ON public.coach_diver_links (diver_id);
CREATE INDEX IF NOT EXISTS idx_coach_diver_org   ON public.coach_diver_links (org_id);

-- 3. Bump schema version.
UPDATE public.schema_meta SET version = 9, applied_at = now() WHERE id = 1;

COMMIT;

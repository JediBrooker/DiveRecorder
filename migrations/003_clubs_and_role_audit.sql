-- =============================================================
-- MIGRATION 003 — CLUBS + ROLE AUDIT LOG
--
-- Adds two related capabilities:
--
--   1. Clubs: a smaller organisational unit nested inside each
--      country-level organisation. Users belong to exactly one
--      club within their org (e.g. "Stanford Diving Club" inside
--      "United States Diving"). The club is optional — divers
--      from independent programmes can have NULL club_id.
--
--   2. Role audit log: every role grant or revoke is recorded
--      with the actor and timestamp so the User Manager can
--      surface a complete history per user — including roles
--      that were later removed.
--
-- Run:
--   psql -d your_db_name -f migrations/003_clubs_and_role_audit.sql
--
-- Idempotent — uses IF NOT EXISTS / DO blocks throughout.
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- CLUBS
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.clubs (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    short_code  varchar(20),
    created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clubs_org ON public.clubs (org_id);

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_club ON public.users (club_id);

-- -------------------------------------------------------------
-- ROLE AUDIT LOG
-- Append-only history of every role grant / revoke. The
-- user_org_roles table only carries roles a user currently
-- holds; this log keeps the full timeline so admins can answer
-- "who had what role when, and who changed it".
-- -------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE role_audit_action AS ENUM ('granted', 'revoked');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.role_audit_log (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    role        org_role NOT NULL,
    action      role_audit_action NOT NULL,
    actor_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    note        text,
    created_at  timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_role_audit_user    ON public.role_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_audit_org     ON public.role_audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_audit_actor   ON public.role_audit_log (actor_id);

COMMIT;
